import os
import io
import re
import json
import uuid
import math
import time
import shutil
import asyncio
import logging
import mimetypes
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Tuple

import requests
from fastapi import (
    FastAPI, Request, UploadFile, File, Form, HTTPException, BackgroundTasks
)
from fastapi.responses import (
    HTMLResponse, JSONResponse, StreamingResponse, FileResponse, RedirectResponse
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ---------- Paths (Render-friendly) ----------
BASE_DIR = Path(__file__).resolve().parent.parent  # repo root
APP_DIR = BASE_DIR / "app"
TEMPLATES_DIR = APP_DIR / "templates"
STATIC_DIR = APP_DIR / "static"

TMP_DIR = Path(os.environ.get("TEMP_UPLOAD_DIR", "/tmp/mailsized"))
TMP_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Binaries (bundled by build.sh) ----------
BIN_DIR = BASE_DIR / "bin"
FFMPEG = str(BIN_DIR / "ffmpeg")
FFPROBE = str(BIN_DIR / "ffprobe")

# ---------- FastAPI ----------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# ---------- Config ----------
MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024  # 2GB
MAX_DURATION_S = 20 * 60                 # 20 min
DOWNLOAD_TTL_MIN = int(os.environ.get("DOWNLOAD_TTL_MIN", "120"))

# Simple price table for UI (same as you had)
PRICING = {
    "gmail":   {"under_3": 1.99, "under_10": 2.99, "under_20": 4.99},
    "outlook": {"under_3": 2.19, "under_10": 3.29, "under_20": 4.99},
    "other":   {"under_3": 2.49, "under_10": 3.99, "under_20": 5.49},
}
UPSSELL = {"priority": 0.75, "transcript": 1.50}

# Email (Mailgun primary, falls back to SMTP if configured)
MAILGUN_DOMAIN = os.environ.get("MAILGUN_DOMAIN", "")
MAILGUN_KEY = os.environ.get("MAILGUN_API_KEY", "")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "noreply@mailsized.com")

SMTP_HOST = os.environ.get("EMAIL_SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("EMAIL_SMTP_PORT", "0") or 0)
SMTP_USER = os.environ.get("EMAIL_USERNAME", "")
SMTP_PASS = os.environ.get("EMAIL_PASSWORD", "")

PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8000")

# Stripe
import stripe
stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")

# ---------- In-memory job store (simple) ----------
@dataclass
class Job:
    id: str
    src_path: Path
    out_path: Path
    provider: str
    email: Optional[str]
    created_at: float
    progress: float = 0.0
    done: bool = False
    error: Optional[str] = None
    duration_s: float = 0.0
    width: int = 0
    height: int = 0
    two_pass: bool = False

JOBS: dict[str, Job] = {}

log = logging.getLogger("mailsized")
logging.basicConfig(level=logging.INFO)

# ---------- Helpers ----------

def human_bytes(n: int) -> str:
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024

def price_for(provider: str, duration_s: float) -> float:
    if duration_s <= 180:
        tier = "under_3"
    elif duration_s <= 600:
        tier = "under_10"
    else:
        tier = "under_20"
    return PRICING.get(provider, PRICING["other"])[tier]

def run(cmd: list[str]) -> subprocess.CompletedProcess:
    """Run a command and raise a clean error with stderr included."""
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(cmd)}\n{proc.stderr}")
    return proc

def probe_info(path: str) -> Tuple[float, int, int]:
    """
    Synchronous ffprobe: returns (duration_s, width, height).
    Safe to call from `await asyncio.to_thread(...)`.
    """
    cmd = [
        FFPROBE, "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,duration",
        "-of", "json", path
    ]
    proc = run(cmd)
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    if not streams:
        # Some files may report duration at the format level — try again:
        cmd2 = [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "json", path]
        p2 = run(cmd2)
        fmt = json.loads(p2.stdout or "{}").get("format", {})
        dur = float(fmt.get("duration") or 0.0)
        return (dur, 0, 0)

    s0 = streams[0]
    dur = float(s0.get("duration") or 0.0)
    width = int(s0.get("width") or 0)
    height = int(s0.get("height") or 0)
    return (dur, width, height)

def size_target_bytes(provider: str) -> int:
    # Gmail 25MB, Outlook 20MB, Other 15MB – leave ~1.5MB headroom for muxing/overhead
    targets = {"gmail": 24_000_000, "outlook": 19_000_000, "other": 14_000_000}
    return targets.get(provider, targets["other"])

def decide_params(duration_s: float, w: int, h: int, provider: str) -> dict:
    """
    Decide resolution, bitrate and whether to do 2-pass to guarantee size.
    """
    # Cap resolution (email previews don’t need more than ~720p; long clips down to 480p)
    max_w, max_h = 1280, 720
    if duration_s > 600:  # >10 min
        max_w, max_h = 854, 480

    # preserve aspect ratio when downscaling
    if w and h and (w > max_w or h > max_h):
        if w / max_w >= h / max_h:
            new_w = max_w
            new_h = int(round(h * (max_w / w) / 2) * 2)
        else:
            new_h = max_h
            new_w = int(round(w * (max_h / h) / 2) * 2)
    else:
        new_w, new_h = (w or max_w), (h or max_h)
        # ensure even dims
        new_w = int(new_w // 2 * 2)
        new_h = int(new_h // 2 * 2)

    # target total bitrate from size budget
    target_size = size_target_bytes(provider)
    # leave ~6% muxing/audio overhead
    video_budget = max(int(target_size * 0.94), 1)
    # audio 80 kbps CBR keeps voices intelligible
    a_kbps = 80
    a_bps = a_kbps * 1000
    v_bps = max(int((video_budget / max(duration_s, 1.0)) - a_bps), 110_000)  # floor ~110kbps

    # choose single vs two-pass:
    # two-pass for clips >90s OR when v_bps < 500 kbps (aggressive compression)
    two_pass = (duration_s > 90) or (v_bps < 500_000)

    return {
        "scale_w": new_w,
        "scale_h": new_h,
        "v_bitrate": v_bps,
        "a_bitrate": a_bps,
        "two_pass": two_pass,
    }

async def ffmpeg_transcode(job: Job) -> None:
    """
    Perform single or two-pass encode. Updates job.progress.
    """
    p = decide_params(job.duration_s, job.width, job.height, job.provider)
    sw, sh = p["scale_w"], p["scale_h"]
    v_bps, a_bps = p["v_bitrate"], p["a_bitrate"]
    job.two_pass = p["two_pass"]

    scale_filter = f"scale={sw}:{sh}:flags=lanczos"

    if not job.two_pass:
        # Single pass
        cmd = [
            FFMPEG, "-y",
            "-i", str(job.src_path),
            "-vf", scale_filter,
            "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
            "-b:v", str(v_bps), "-maxrate", str(v_bps), "-bufsize", str(int(v_bps * 2)),
            "-c:a", "aac", "-b:a", str(a_bps), "-movflags", "+faststart",
            str(job.out_path),
        ]
        log.info("ffmpeg single-pass: %s", " ".join(cmd))
        await asyncio.to_thread(run, cmd)
        job.progress = 100.0
        job.done = True
        return

    # Two-pass (stats file in /tmp)
    stats = TMP_DIR / f"{job.id}.log"

    pass1 = [
        FFMPEG, "-y",
        "-i", str(job.src_path),
        "-vf", scale_filter,
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", str(v_bps),
        "-pass", "1", "-passlogfile", str(stats),
        "-an", "-f", "mp4", os.devnull,
    ]
    pass2 = [
        FFMPEG, "-y",
        "-i", str(job.src_path),
        "-vf", scale_filter,
        "-c:v", "libx264", "-preset", "veryfast", "-b:v", str(v_bps),
        "-pass", "2", "-passlogfile", str(stats),
        "-c:a", "aac", "-b:a", str(a_bps), "-movflags", "+faststart",
        str(job.out_path),
    ]

    log.info("ffmpeg two-pass pass1: %s", " ".join(pass1))
    await asyncio.to_thread(run, pass1)
    job.progress = 50.0

    log.info("ffmpeg two-pass pass2: %s", " ".join(pass2))
    await asyncio.to_thread(run, pass2)
    job.progress = 100.0
    job.done = True

    # cleanup
    try:
        for ext in [".log", ".log.mbtree"]:
            pth = TMP_DIR / f"{job.id}{ext}"
            if pth.exists():
                pth.unlink(missing_ok=True)
    except Exception:
        pass

def send_email(download_url: str, to_addr: Optional[str]) -> None:
    if not to_addr:
        return

    # Try Mailgun first
    if MAILGUN_DOMAIN and MAILGUN_KEY:
        try:
            r = requests.post(
                f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
                auth=("api", MAILGUN_KEY),
                data={
                    "from": f"MailSized <{SENDER_EMAIL}>",
                    "to": [to_addr],
                    "subject": "Your MailSized video is ready",
                    "text": f"Download your compressed video: {download_url}\nThis link expires in {DOWNLOAD_TTL_MIN} minutes.",
                },
                timeout=20,
            )
            r.raise_for_status()
            log.info("Email sent via Mailgun to %s", to_addr)
            return
        except Exception as e:
            log.warning("Mailgun failed: %s", e)

    # Fallback SMTP (optional)
    if SMTP_HOST and SMTP_PORT and SMTP_USER and SMTP_PASS:
        import smtplib
        from email.message import EmailMessage
        msg = EmailMessage()
        msg["From"] = SENDER_EMAIL
        msg["To"] = to_addr
        msg["Subject"] = "Your MailSized video is ready"
        msg.set_content(f"Download your compressed video: {download_url}\nThis link expires in {DOWNLOAD_TTL_MIN} minutes.")
        try:
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20) as s:
                s.starttls()
                s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
            log.info("Email sent via SMTP to %s", to_addr)
        except Exception as e:
            log.warning("SMTP failed: %s", e)

# ---------- Routes ----------

@app.get("/", response_class=HTMLResponse)
async def home(request: Request, paid: Optional[str] = None, job_id: Optional[str] = None):
    adsense_tag = ""
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "adsense_tag": adsense_tag,
            "adsense_client_id": os.environ.get("ADSENSE_CLIENT_ID", ""),
        },
    )

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    try:
        # size guard while streaming to tempfile
        file_id = str(uuid.uuid4())
        suffix = Path(file.filename).suffix or ".mp4"
        temp_path = TMP_DIR / f"src_{file_id}{suffix}"
        size_written = 0

        with open(temp_path, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)  # 1MB
                if not chunk:
                    break
                size_written += len(chunk)
                if size_written > MAX_SIZE_BYTES:
                    f.close()
                    temp_path.unlink(missing_ok=True)
                    return JSONResponse({"ok": False, "error": "File exceeds 2GB limit."}, status_code=400)
                f.write(chunk)

        # probe
        duration, width, height = await asyncio.to_thread(probe_info, str(temp_path))
        if duration > MAX_DURATION_S:
            temp_path.unlink(missing_ok=True)
            return JSONResponse({"ok": False, "error": "Video exceeds 20 minute limit."}, status_code=400)

        return JSONResponse(
            {
                "ok": True,
                "file_id": file_id,
                "file_name": file.filename,
                "temp_path": str(temp_path),  # used by /checkout
                "bytes": size_written,
                "duration": duration,
                "width": width,
                "height": height,
                "bytes_h": human_bytes(size_written),
            }
        )
    except Exception as e:
        log.exception("Upload failed")
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)

@app.post("/checkout")
async def checkout(
    provider: str = Form(...),
    temp_path: str = Form(...),
    user_email: Optional[str] = Form(None),
    priority: Optional[bool] = Form(False),
    transcript: Optional[bool] = Form(False),
):
    # Create a job record now; Stripe webhook marks it active to start encoding.
    job_id = str(uuid.uuid4())
    src = Path(temp_path)
    outp = TMP_DIR / f"out_{job_id}.mp4"

    # probe again to record (no heavy IO)
    duration, width, height = await asyncio.to_thread(probe_info, str(src))
    JOBS[job_id] = Job(
        id=job_id, src_path=src, out_path=outp, provider=provider,
        email=user_email, created_at=time.time(),
        duration_s=duration, width=width, height=height
    )

    # Create a Stripe Checkout Session (you already had this working)
    amount = int(round(price_for(provider, duration) + (UPSSELL["priority"] if priority else 0) + (UPSSELL["transcript"] if transcript else 0), 2) * 100)
    sess = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "quantity": 1,
            "price_data": {
                "currency": "usd",
                "unit_amount": amount,
                "product_data": {"name": f"MailSized compression – {provider}"},
            },
        }],
        success_url=f"{PUBLIC_BASE_URL}/?paid=1&job_id={job_id}",
        cancel_url=f"{PUBLIC_BASE_URL}/",
        metadata={"job_id": job_id, "provider": provider},
    )
    return JSONResponse({"ok": True, "url": sess.url})

@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")

    try:
        if STRIPE_WEBHOOK_SECRET:
            event = stripe.Webhook.construct_event(payload, sig, STRIPE_WEBHOOK_SECRET)
        else:
            event = json.loads(payload)
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=400)

    if event.get("type") == "checkout.session.completed":
        sess = event["data"]["object"]
        job_id = sess.get("metadata", {}).get("job_id")
        if job_id and job_id in JOBS:
            job = JOBS[job_id]
            log.info("Started job %s after Stripe payment", job_id)
            asyncio.create_task(worker(job))
    return JSONResponse({"ok": True})

async def worker(job: Job):
    try:
        await ffmpeg_transcode(job)
        # send email link
        url = f"{PUBLIC_BASE_URL}/download/{job.id}"
        send_email(url, job.email)
    except Exception as e:
        job.error = str(e)
        log.exception("Job %s failed", job.id)

@app.get("/events/{job_id}")
async def sse(job_id: str):
    async def gen():
        while True:
            job = JOBS.get(job_id)
            if not job:
                yield f"data: {json.dumps({'ok': False, 'error': 'unknown job'})}\n\n"
                return
            payload = {
                "ok": True,
                "progress": job.progress,
                "done": job.done,
                "error": job.error,
                "download": f"/download/{job.id}" if job.done and not job.error else None,
                "two_pass": job.two_pass,
            }
            yield f"data: {json.dumps(payload)}\n\n"
            if job.done or job.error:
                return
            await asyncio.sleep(1.2)
    return StreamingResponse(gen(), media_type="text/event-stream")

@app.get("/download/{job_id}")
async def download(job_id: str):
    job = JOBS.get(job_id)
    if not job or not job.out_path.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(
        path=str(job.out_path),
        filename=f"mailsized_{job_id}.mp4",
        media_type="video/mp4"
    )
