# app/main.py
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import smtplib
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from email.message import EmailMessage
from pathlib import Path
from typing import AsyncIterator, Dict, Optional, Tuple

import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader, select_autoescape

# ---------- Paths (fixed) ----------
APP_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = APP_DIR / "templates"
STATIC_DIR = APP_DIR / "static"
DATA_DIR = APP_DIR / ".." / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
for p in (DATA_DIR, UPLOAD_DIR, OUTPUT_DIR):
    p.mkdir(parents=True, exist_ok=True)

# ffmpeg/ffprobe (we install static builds into /opt/render/project/src/bin in build.sh)
BIN_DIR = Path(os.environ.get("BIN_DIR", "/opt/render/project/src/bin"))
FFMPEG = str(BIN_DIR / "ffmpeg")
FFPROBE = str(BIN_DIR / "ffprobe")

# ---------- App ----------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # your domains if you want stricter
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# static & templates mount (fixed order)
if not STATIC_DIR.exists():
    raise RuntimeError(f"Static directory missing: {STATIC_DIR}")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=select_autoescape(["html", "xml"]),
)

# ---------- Pricing / Capacities ----------
PROVIDER_CAP_MB = {"gmail": 25, "outlook": 20, "other": 15}

# client shows prices; server doesn’t charge here, but we keep extras for receipts/emails
@dataclass
class UploadMeta:
    upload_id: str
    src_path: Path
    size_bytes: int
    duration_sec: float
    width: int
    height: int
    email: Optional[str] = None
    provider: str = "gmail"
    priority: bool = False
    transcript: bool = False

@dataclass
class JobState:
    job_id: str
    upload: UploadMeta
    status: str = "queued"  # queued|running|done|error
    progress: float = 0.0
    message: str = ""
    out_path: Optional[Path] = None
    error: Optional[str] = None
    q: asyncio.Queue = field(default_factory=asyncio.Queue)

# in‑mem store
UPLOADS: Dict[str, UploadMeta] = {}
JOBS: Dict[str, JobState] = {}

# ---------- Helpers ----------
def _run(cmd: str) -> subprocess.CompletedProcess:
    return subprocess.run(shlex.split(cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False)

def probe_info(path: str) -> Tuple[float, int, int]:
    """
    Returns (duration_sec, width, height) using ffprobe.
    Synchronous (fix for 'cannot unpack non-iterable coroutine object').
    """
    if not Path(path).exists():
        raise FileNotFoundError(path)
    # duration
    d = _run(f"{FFPROBE} -v error -show_entries format=duration -of json {shlex.quote(path)}")
    dur = 0.0
    try:
        dur = float(json.loads(d.stdout or "{}").get("format", {}).get("duration", 0.0))
    except Exception:
        pass
    # width/height
    s = _run(f"{FFPROBE} -v error -select_streams v:0 -show_entries stream=width,height -of json {shlex.quote(path)}")
    width = height = 0
    try:
        st = json.loads(s.stdout or "{}").get("streams", [{}])[0]
        width = int(st.get("width") or 0)
        height = int(st.get("height") or 0)
    except Exception:
        pass
    return max(dur, 0.0), width, height

def choose_target(provider: str, size_bytes: int) -> int:
    """Return target size in bytes based on provider cap with a safety margin."""
    cap_mb = PROVIDER_CAP_MB.get(provider, 15)
    # keep 8% headroom for container overhead + audio + variability
    return int((cap_mb - 1.5) * 1024 * 1024)

def compute_bitrates(duration_sec: float, target_bytes: int) -> Tuple[int, int]:
    """
    Split total budget into video+audio bitrates (bps).
    Default audio 80 kbps. Never below 400 kbps video to avoid mush.
    """
    if duration_sec <= 0:
        # fallback 2 minute guess
        duration_sec = 120.0
    total_bits = target_bytes * 8
    # leave ~6% mux overhead
    total_bits = int(total_bits * 0.94)
    audio_kbps = 80
    audio_bps = audio_kbps * 1000
    video_bps = max(int(total_bits / duration_sec) - audio_bps, 400_000)
    return video_bps, audio_bps

def decide_two_pass(duration_sec: float, video_bps: int) -> bool:
    """
    Heuristic: 2‑pass only if long or tight budget.
    """
    # long content
    if duration_sec >= 120:  # >=2 min
        return True
    # very low bitrate
    if video_bps <= 600_000:
        return True
    return False

def auto_scale(width: int, height: int, video_bps: int) -> Tuple[int, int]:
    """Downscale to help hit target; maintain 16:9-ish, even dims."""
    if width <= 0 or height <= 0:
        # unknown → choose a conservative floor if bitrate small
        if video_bps < 600_000:
            return 960, 540
        return 1280, 720

    target_w, target_h = width, height
    px = width * height
    # rough ladder based on bitrate
    if video_bps < 500_000:
        target_w, target_h = 854, 480
    elif video_bps < 900_000:
        target_w, target_h = 1280, 720
    else:
        # keep original unless it's huge 1080p+
        if px > 1920 * 1080:
            target_w, target_h = 1920, 1080

    # make even
    target_w -= target_w % 2
    target_h -= target_h % 2
    return max(target_w, 2), max(target_h, 2)

async def sse_stream(job: JobState) -> AsyncIterator[bytes]:
    """Reliable SSE with heartbeats."""
    # send last known state immediately
    first = {
        "type": "state",
        "progress": round(job.progress, 1),
        "status": job.status,
        "message": job.message,
    }
    yield f"data: {json.dumps(first)}\n\n".encode()

    last_heartbeat = time.time()
    while True:
        try:
            item = await asyncio.wait_for(job.q.get(), timeout=5.0)
            yield f"data: {json.dumps(item)}\n\n".encode()
            if item.get("status") in ("done", "error"):
                # give the client a moment to flush
                await asyncio.sleep(0.25)
                return
        except asyncio.TimeoutError:
            # heartbeat (keeps Render / proxies from 502)
            if time.time() - last_heartbeat >= 5:
                yield b": keep-alive\n\n"
                last_heartbeat = time.time()

def put(job: JobState, **payload):
    job.q.put_nowait(payload)

# ---------- Email ----------
MAILGUN_KEY = os.environ.get("MAILGUN_API_KEY", "")
MAILGUN_DOMAIN = os.environ.get("MAILGUN_DOMAIN", "")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://mailsized.com")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "noreply@mailsized.com")

SMTP_HOST = os.environ.get("EMAIL_SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("EMAIL_SMTP_PORT", "587") or "587")
SMTP_USER = os.environ.get("EMAIL_USERNAME", "")
SMTP_PASS = os.environ.get("EMAIL_PASSWORD", "")

def send_email_download(to_email: str, download_url: str) -> None:
    if not to_email:
        return
    subject = "Your compressed video is ready"
    html = f"""
    <p>Your file has been compressed. You can download it here:</p>
    <p><a href="{download_url}">{download_url}</a></p>
    <p>Link expires in ~24 hours.</p>
    """

    # Try Mailgun first
    if MAILGUN_KEY and MAILGUN_DOMAIN:
        try:
            r = requests.post(
                f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
                auth=("api", MAILGUN_KEY),
                data={
                    "from": f"MailSized <{SENDER_EMAIL}>",
                    "to": [to_email],
                    "subject": subject,
                    "html": html,
                },
                timeout=10,
            )
            r.raise_for_status()
            return
        except Exception:
            # fall back to SMTP
            pass

    # SMTP fallback
    if SMTP_HOST and SMTP_USER and SMTP_PASS:
        try:
            msg = EmailMessage()
            msg["From"] = SENDER_EMAIL
            msg["To"] = to_email
            msg["Subject"] = subject
            msg.set_content(html, subtype="html")
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
                s.starttls()
                s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
            return
        except Exception:
            # as last resort, silently ignore to avoid breaking UX
            return

# ---------- Views ----------
@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    template = env.get_template("index.html")
    adsense_tag = ""
    if os.environ.get("ENABLE_ADSENSE") == "1":
        client = os.environ.get("ADSENSE_CLIENT_ID", "")
        adsense_tag = f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={client}" crossorigin="anonymous"></script>'
    job_id = request.query_params.get("job_id") or ""
    paid = request.query_params.get("paid") == "1"
    return template.render(adsense_tag=adsense_tag, paid=paid, job_id=job_id)

# ---------- API ----------
@app.post("/upload")
async def upload(
    file: UploadFile = File(...),
    email: Optional[str] = Form(None),
):
    if not file.filename:
        raise HTTPException(400, "Missing filename")
    # save to disk
    upload_id = str(uuid.uuid4())
    temp_path = UPLOAD_DIR / f"{upload_id}_{file.filename}"
    with temp_path.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)

    # probe sync (fix)
    try:
        duration, width, height = probe_info(str(temp_path))
    except Exception as e:
        raise HTTPException(400, f"Probe failed: {e}")

    meta = UploadMeta(
        upload_id=upload_id,
        src_path=temp_path,
        size_bytes=temp_path.stat().st_size,
        duration_sec=duration,
        width=width,
        height=height,
        email=email or None,
    )
    UPLOADS[upload_id] = meta

    return JSONResponse(
        {
            "ok": True,
            "upload_id": upload_id,
            "duration_sec": duration,
            "size_bytes": meta.size_bytes,
            "width": width,
            "height": height,
        }
    )

@app.post("/checkout")
async def checkout(payload: dict):
    """
    The client calls this after upload to create a job record and (in your live app)
    create a Stripe Checkout session. Here we accept the payload and return ok.
    Stripe webhook will actually start the job (same as your current flow).
    """
    upload_id = payload.get("upload_id")
    provider = (payload.get("provider") or "gmail").lower()
    priority = bool(payload.get("priority"))
    transcript = bool(payload.get("transcript"))
    email = payload.get("email") or None

    if upload_id not in UPLOADS:
        raise HTTPException(404, "upload not found")

    # attach selections to upload meta for the webhook handler
    u = UPLOADS[upload_id]
    u.provider = provider
    u.priority = priority
    u.transcript = transcript
    if email:
        u.email = email

    # In production, return Stripe session URL; for now just say "ok"
    return {"ok": True, "message": "checkout created"}

@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    """
    Minimal webhook: assume event checkout.session.completed contains `upload_id`
    you stored via metadata in your live integration. For sandbox/testing, the
    client already has upload_id in query (?paid=1&job_id=...); we start job here.
    """
    body = await request.body()
    try:
        data = json.loads(body.decode() or "{}")
    except Exception:
        data = {}

    # Try to find upload_id from metadata; if missing, ignore gracefully
    upload_id = None
    try:
        upload_id = data.get("data", {}).get("object", {}).get("metadata", {}).get("upload_id")
    except Exception:
        pass

    # Fallback: allow client to send ?upload_id in test POSTs
    if not upload_id:
        upload_id = request.query_params.get("upload_id")

    if not upload_id or upload_id not in UPLOADS:
        # nothing to do
        return {"ok": True}

    # spin a job
    job_id = str(uuid.uuid4())
    job = JobState(job_id=job_id, upload=UPLOADS[upload_id], status="queued", progress=0.0)
    JOBS[job_id] = job

    # kick background
    asyncio.create_task(run_job(job))
    # return 200 to Stripe
    return {"ok": True, "job_id": job_id}

@app.get("/events/{job_id}")
async def events(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        # create a stub so the stream returns something instead of 502
        dummy = JobState(job_id=job_id, upload=UploadMeta(upload_id="", src_path=Path(""), size_bytes=0, duration_sec=0, width=0, height=0))
        put(dummy, type="state", status="error", progress=0, message="Unknown job")
        return StreamingResponse(sse_stream(dummy), media_type="text/event-stream")
    return StreamingResponse(sse_stream(job), media_type="text/event-stream")

@app.get("/download/{job_id}")
def download(job_id: str):
    job = JOBS.get(job_id)
    if not job or job.status != "done" or not job.out_path:
        raise HTTPException(404, "Not ready")
    # In your real app you might return FileResponse; here we give a signed-ish URL
    return JSONResponse({"ok": True, "url": f"{PUBLIC_BASE_URL}/media/{job.out_path.name}"})

# (Optionally add a static mount for outputs if you serve them directly)
app.mount("/media", StaticFiles(directory=str(OUTPUT_DIR)), name="media")

# ---------- Worker ----------
async def run_job(job: JobState):
    u = job.upload
    job.status = "running"
    put(job, type="state", status="running", progress=0.0, message="Starting…")

    try:
        # Compute target
        target_bytes = choose_target(u.provider, u.size_bytes)
        v_bps, a_bps = compute_bitrates(u.duration_sec, target_bytes)
        do_two_pass = decide_two_pass(u.duration_sec, v_bps)
        tw, th = auto_scale(u.width, u.height, v_bps)

        # Build output path
        out_name = f"{job.job_id}.mp4"
        out_path = OUTPUT_DIR / out_name
        # Clean any previous leftovers
        if out_path.exists():
            out_path.unlink(missing_ok=True)

        # Common flags
        vf = f"scale=w={tw}:h={th}:force_original_aspect_ratio=decrease:flags=bicubic"
        common = [
            FFMPEG, "-y",
            "-i", str(u.src_path),
            "-vf", vf,
            "-c:v", "libx264",
            "-preset", "veryfast" if u.priority else "faster",
            "-movflags", "+faststart",
            "-c:a", "aac",
            "-b:a", str(a_bps),
            "-max_muxing_queue_size", "9999",
        ]

        # Use -progress pipe to parse % (reliable progress)
        def percent_from_out_time_ms(line: str) -> Optional[float]:
            m = re.match(r"out_time_ms=(\d+)", line.strip())
            if m:
                ms = int(m.group(1))
                if u.duration_sec > 0:
                    return min(99.0, (ms / 1000000.0) / u.duration_sec * 100.0)
            return None

        async def run_and_stream(cmd: list[str]) -> int:
            proc = await asyncio.create_subprocess_exec(
                *cmd, "-progress", "pipe:1", "-nostats", "-loglevel", "error",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            last_emit = 0.0
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                try:
                    txt = line.decode("utf-8", "ignore")
                except Exception:
                    txt = ""
                if "out_time_ms=" in txt:
                    pct = percent_from_out_time_ms(txt)
                    if pct is not None and pct - last_emit >= 1.0:
                        job.progress = pct
                        put(job, type="progress", progress=round(pct, 1), status="running", message="Compressing…")
                        last_emit = pct
            rc = await proc.wait()
            return rc

        if do_two_pass:
            # Pass 1
            cmd1 = common + [
                "-b:v", str(v_bps),
                "-pass", "1",
                "-f", "mp4",
                "/dev/null",
            ]
            rc1 = await run_and_stream(cmd1)
            if rc1 != 0:
                raise RuntimeError("FFmpeg pass 1 failed")

            # Pass 2
            cmd2 = common + [
                "-b:v", str(v_bps),
                "-pass", "2",
                str(out_path),
            ]
            rc2 = await run_and_stream(cmd2)
            if rc2 != 0:
                raise RuntimeError("FFmpeg pass 2 failed")
        else:
            # Single pass CBR-ish
            cmd = common + [
                "-b:v", str(v_bps),
                "-maxrate", str(int(v_bps * 1.2)),
                "-bufsize", str(int(v_bps * 2)),
                str(out_path),
            ]
            rc = await run_and_stream(cmd)
            if rc != 0:
                raise RuntimeError("FFmpeg failed")

        # small final probe for confidence
        final_size = out_path.stat().st_size if out_path.exists() else 0
        if final_size <= 0:
            raise RuntimeError("Output missing")

        job.progress = 100.0
        job.status = "done"
        job.out_path = out_path
        put(job, type="state", status="done", progress=100.0, message="Complete")

        # email (best effort)
        if u.email:
            dl_url = f"{PUBLIC_BASE_URL}/media/{out_path.name}"
            send_email_download(u.email, dl_url)

    except Exception as e:
        job.status = "error"
        job.error = str(e)
        put(job, type="state", status="error", progress=job.progress, message=str(e))

# ---------- Health ----------
@app.get("/healthz")
def healthz():
    return {"ok": True}
