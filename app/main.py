from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import requests
import stripe
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ----------------- Logging -----------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mailsized")

# ----------------- Stripe ------------------
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

# ----------------- App FIRST ----------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten to your domain in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ----------------- Paths --------------------
APP_DIR = Path(__file__).resolve().parent
REPO_DIR = APP_DIR.parent

def pick_dir(cands: list[Path], label: str, create=False) -> Path:
    for d in cands:
        if d.exists() and d.is_dir():
            return d
    d = cands[0]
    if create:
        d.mkdir(parents=True, exist_ok=True)
        logger.warning("%s not found; creating %s", label, d)
    else:
        logger.warning("%s not found; tried: %s", label, [str(x) for x in cands])
    return d

STATIC_DIR = pick_dir(
    [APP_DIR / "static", REPO_DIR / "static", Path("/opt/render/project/src/app/static")],
    "static", create=True
)
TEMPLATES_DIR = pick_dir(
    [APP_DIR / "templates", REPO_DIR / "templates", Path("/opt/render/project/src/app/templates")],
    "templates", create=True
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# Temp folder
TEMP_UPLOAD_DIR = Path("/opt/render/project/src/temp_uploads") if "RENDER" in os.environ else (APP_DIR / "temp_uploads")
TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ----------------- Limits / Pricing ----------
MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi"}

PROVIDER_TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}
PROVIDER_PRICING = {
    "gmail":   [1.99, 2.99, 4.99],
    "outlook": [2.19, 3.29, 4.99],
    "other":   [2.49, 3.99, 5.49],
}

# ----------------- Job Model -----------------
class JobStatus:
    QUEUED      = "queued"
    PROCESSING  = "processing"
    COMPRESSING = "compressing"
    FINALIZING  = "finalizing"
    DONE        = "done"
    ERROR       = "error"

class Job:
    def __init__(self, job_id: str, file_path: str, duration: float, size_bytes: int, pricing: Dict[str, Any]):
        self.job_id = job_id
        self.file_path = file_path
        self.duration = duration
        self.size_bytes = size_bytes
        self.pricing = pricing

        self.provider: Optional[str] = None
        self.priority: bool = False
        self.transcript: bool = False
        self.email: Optional[str] = None
        self.target_size_mb: Optional[int] = None

        self.status: str = JobStatus.QUEUED
        self.output_path: Optional[str] = None
        self.download_expiry: Optional[datetime] = None
        self.progress_pct: float = 0.0

    @property
    def download_url(self) -> Optional[str]:
        if self.status != JobStatus.DONE or not self.output_path:
            return None
        return f"/download/{self.job_id}"

jobs: Dict[str, Job] = {}

# ----------------- Utils ---------------------
def adsense_script_tag() -> str:
    enabled = os.getenv("ENABLE_ADSENSE", "false").lower() == "true"
    consent = os.getenv("CONSENT_GIVEN", "false").lower() == "true"
    client = os.getenv("ADSENSE_CLIENT_ID", "").strip()
    if not (enabled and consent and client):
        return ""
    return (
        f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={client}" '
        'crossorigin="anonymous"></script>'
    )

def ffbin(name: str) -> str:
    # Prefer static binaries installed by build.sh
    cand = REPO_DIR / "bin" / name
    return str(cand) if cand.exists() else name

FFMPEG = ffbin("ffmpeg")
FFPROBE = ffbin("ffprobe")

async def probe_info(path: str) -> Tuple[float, int, int]:
    """Return (duration_sec, width, height). Width/height may be 0 if probe fails."""
    try:
        # duration
        p1 = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, check=True
        )
        duration = float(p1.stdout.strip() or "0")
    except Exception as e:
        logger.warning("ffprobe duration failed: %s", e)
        duration = 0.0

    w = h = 0
    try:
        p2 = subprocess.run(
            [FFPROBE, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, check=True
        )
        line = (p2.stdout.strip() or "0,0").split(",")
        if len(line) >= 2:
            w = int(line[0] or "0")
            h = int(line[1] or "0")
    except Exception as e:
        logger.warning("ffprobe wh failed: %s", e)
    return duration, w, h

def pick_tier(duration_sec: int, size_bytes: int) -> Dict[str, Any]:
    minutes = duration_sec / 60
    mb = size_bytes / (1024 * 1024)
    if minutes <= 5 and mb <= 500:
        return {"tier": 1, "price": 1.99, "max_length_min": 5, "max_size_mb": 500}
    if minutes <= 10 and mb <= 1024:
        return {"tier": 2, "price": 2.99, "max_length_min": 10, "max_size_mb": 1024}
    if minutes <= 20 and mb <= 2048:
        return {"tier": 3, "price": 4.99, "max_length_min": 20, "max_size_mb": 2048}
    raise ValueError("Video exceeds allowed limits for all tiers.")

def pick_scale_for_vkbps(in_w: int, in_h: int, vkbps: int) -> Optional[str]:
    """
    Choose a downscale if the available video bitrate is tight.
    Tries to maintain AR; returns an ffmpeg scale filter or None.
    """
    if in_w <= 0 or in_h <= 0:
        return None

    # thresholds from testing: quality/bitrate tradeoffs
    # >1200 kbps: keep res
    # 800-1200: cap to 1080p
    # 500-800: cap to 720p
    # 300-500: cap to 540p
    # <300: cap to 480p
    if vkbps < 300:
        cap_w = 854   # 480p-ish (16:9)
    elif vkbps < 500:
        cap_w = 960   # ~540p
    elif vkbps < 800:
        cap_w = 1280  # 720p
    elif vkbps < 1200:
        cap_w = 1920  # 1080p
    else:
        return None

    if in_w <= cap_w:
        return None

    # keep AR, mod2 dimensions
    return f"scale='min({cap_w},iw)':'trunc(oh*a/2)*2'"

def decide_passes_and_bitrate(in_size_bytes: int, duration: float, target_mb: int) -> Dict[str, Any]:
    """
    Return dict with:
      - use_two_pass: bool
      - a_kbps: int
      - v_kbps: int
    """
    target_bytes = target_mb * 1024 * 1024
    if duration <= 0:
        duration = 1

    # If input already under target by a margin, copy to save time.
    if in_size_bytes <= int(target_bytes * 0.98):
        return {"use_two_pass": False, "copy": True, "a_kbps": 0, "v_kbps": 0}

    # bit budget
    a_kbps = 80  # AAC 80 kbps good enough for spoken content
    a_bytes = int((a_kbps * 1000 / 8) * duration)
    # container overhead ~2%
    overhead = int(target_bytes * 0.02)
    v_bytes = max(0, target_bytes - a_bytes - overhead)
    v_bps = max(180_000, int(v_bytes * 8 / duration))  # clamp min ~180kbps
    v_kbps = int(v_bps / 1000)

    # Use 2-pass when the target is tight or duration > 120s
    use_two_pass = (v_kbps < 1400) or (duration > 120)
    return {"use_two_pass": use_two_pass, "copy": False, "a_kbps": a_kbps, "v_kbps": v_kbps}

async def send_email(recipient: str, download_url: str) -> None:
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your compressed video is ready"
    body = f"Your video is ready for the next 30 minutes:\n{download_url}"

    mg_api_key = os.getenv("MAILGUN_API_KEY")
    mg_domain = os.getenv("MAILGUN_DOMAIN")
    if mg_api_key and mg_domain and recipient:
        try:
            r = requests.post(
                f"https://api.mailgun.net/v3/{mg_domain}/messages",
                auth=("api", mg_api_key),
                data={
                    "from": sender,
                    "to": [recipient],
                    "subject": subject,
                    "text": body,
                    "h:Auto-Submitted": "auto-generated",
                    "h:X-Auto-Response-Suppress": "All",
                    "h:Reply-To": "no-reply@mailsized.com",
                },
                timeout=12,
            )
            r.raise_for_status()
            logger.info("Email sent via Mailgun to %s", recipient)
            return
        except Exception as exc:
            logger.warning("Mailgun send failed: %s", exc)

    # SMTP fallback
    host = os.getenv("EMAIL_SMTP_HOST")
    port = os.getenv("EMAIL_SMTP_PORT")
    username = os.getenv("EMAIL_USERNAME")
    password = os.getenv("EMAIL_PASSWORD")
    if not (host and port and username and password and recipient):
        logger.info("Email not sent: no Mailgun or SMTP creds")
        return

    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    msg = MIMEMultipart()
    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = subject
    msg["Auto-Submitted"] = "auto-generated"
    msg["X-Auto-Response-Suppress"] = "All"
    msg["Reply-To"] = "no-reply@mailsized.com"
    msg.attach(MIMEText(body, "plain"))

    try:
        with smtplib.SMTP(host, int(port)) as server:
            server.starttls()
            server.login(username, password)
            server.send_message(msg)
        logger.info("Email sent via SMTP to %s", recipient)
    except Exception as exc:
        logger.warning("SMTP send failed: %s", exc)

# ----------------- Compression ----------------
async def run_ffmpeg_progress(cmd: list[str], total_ms: int, job: Job, pass_idx: int, total_passes: int):
    """
    Run FFmpeg with `-progress pipe:1` and report `%` via SSE.
    We weight passes evenly: e.g., 2-pass => each ~50% of total.
    """
    weight = 100.0 / total_passes
    base = weight * (pass_idx - 1)

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # FFmpeg prints key=value lines on stdout with -progress pipe:1
    if not proc.stdout:
        await proc.wait()
        return await proc.wait()

    try:
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            s = line.decode(errors="ignore").strip()
            # out_time_ms=123456
            if s.startswith("out_time_ms="):
                try:
                    cur_ms = int(s.split("=", 1)[1] or "0")
                    frac = min(1.0, max(0.0, cur_ms / max(1, total_ms)))
                    job.progress_pct = round(base + frac * weight, 1)
                except Exception:
                    pass
    finally:
        rc = await proc.wait()
        if rc != 0:
            # show last stderr lines for debugging
            if proc.stderr:
                err = (await proc.stderr.read()).decode(errors="ignore")
                logger.warning("FFmpeg stderr: %s", err[-800:])
        return rc

async def compress_to_target(job: Job, src: str, dst: str, target_mb: int) -> None:
    # Probe info
    duration, in_w, in_h = await asyncio.to_thread(probe_info, src)
    if duration <= 0:
        # fallback to earlier probed duration
        duration = max(job.duration, 1.0)
    total_ms = int(duration * 1000)

    decision = decide_passes_and_bitrate(job.size_bytes, duration, target_mb)
    if decision.get("copy"):
        # already under cap: fast copy
        logger.info("Input under cap; stream copy.")
        cmd = [
            FFMPEG, "-y", "-i", src,
            "-c", "copy", "-movflags", "+faststart",
            dst
        ]
        rc = await run_ffmpeg_progress(cmd + ["-progress", "pipe:1"], total_ms, job, 1, 1)
        if rc != 0:
            raise RuntimeError("FFmpeg copy failed")
        return

    a_kbps = decision["a_kbps"]
    v_kbps = decision["v_kbps"]
    use_two = decision["use_two_pass"]

    scale = pick_scale_for_vkbps(in_w, in_h, v_kbps)
    vf = []
    if scale:
        vf = ["-vf", scale]

    # Safety: align rate controls
    maxrate = f"{int(v_kbps)}k"
    bufsize = f"{int(v_kbps * 2)}k"
    a_bitrate = f"{a_kbps}k"
    v_bitrate = f"{int(v_kbps)}k"

    passlog = str(TEMP_UPLOAD_DIR / f"ffpass_{job.job_id}")

    if not use_two:
        # single-pass CBR-ish (guarantee-ish size) using -b:v + -maxrate
        logger.info("Single-pass v=%sk a=%sk", v_kbps, a_kbps)
        cmd = [
            FFMPEG, "-y", "-i", src,
            *vf,
            "-c:v", "libx264", "-preset", "medium", "-profile:v", "high",
            "-pix_fmt", "yuv420p",
            "-b:v", v_bitrate, "-maxrate", maxrate, "-bufsize", bufsize,
            "-movflags", "+faststart",
            "-c:a", "aac", "-b:a", a_bitrate, "-ac", "2",
            "-progress", "pipe:1",
            dst,
        ]
        rc = await run_ffmpeg_progress(cmd, total_ms, job, 1, 1)
        if rc != 0:
            raise RuntimeError("FFmpeg single-pass failed")
        return

    # two-pass: each pass contributes ~50%
    logger.info("Two-pass v=%sk a=%sk", v_kbps, a_kbps)

    # PASS 1 (no audio, write stats)
    cmd1 = [
        FFMPEG, "-y", "-i", src,
        *vf,
        "-c:v", "libx264", "-preset", "medium", "-b:v", v_bitrate,
        "-maxrate", maxrate, "-bufsize", bufsize,
        "-pass", "1", "-passlogfile", passlog,
        "-an",
        "-f", "mp4",
        "-progress", "pipe:1",
        os.devnull if os.name != "nt" else "NUL",
    ]
    rc1 = await run_ffmpeg_progress(cmd1, total_ms, job, 1, 2)
    if rc1 != 0:
        raise RuntimeError("FFmpeg pass 1 failed")

    # PASS 2 (with audio)
    cmd2 = [
        FFMPEG, "-y", "-i", src,
        *vf,
        "-c:v", "libx264", "-preset", "medium", "-b:v", v_bitrate,
        "-maxrate", maxrate, "-bufsize", bufsize,
        "-pass", "2", "-passlogfile", passlog,
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-c:a", "aac", "-b:a", a_bitrate, "-ac", "2",
        "-progress", "pipe:1",
        dst,
    ]
    rc2 = await run_ffmpeg_progress(cmd2, total_ms, job, 2, 2)
    # Cleanup pass logs
    for ext in (".log", ".log.mbtree"):
        f = Path(passlog + ext)
        if f.exists():
            f.unlink(missing_ok=True)

    if rc2 != 0:
        raise RuntimeError("FFmpeg pass 2 failed")

# ----------------- Pipeline -------------------
async def run_job(job: Job) -> None:
    try:
        job.status = JobStatus.PROCESSING
        await asyncio.sleep(0.3)

        job.status = JobStatus.COMPRESSING
        out_name = f"compressed_{job.job_id}.mp4"
        job.output_path = str(TEMP_UPLOAD_DIR / out_name)

        await compress_to_target(job, job.file_path, job.output_path, job.target_size_mb or 25)
        job.progress_pct = 100.0

        job.status = JobStatus.FINALIZING
        ttl_min = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
        job.download_expiry = datetime.utcnow() + timedelta(minutes=ttl_min)

        job.status = JobStatus.DONE

        if job.email:
            await send_email(job.email, job.download_url or "")

        asyncio.create_task(cleanup_job(job.job_id))
    except Exception as exc:
        logger.exception("Error during job %s: %s", job.job_id, exc)
        job.status = JobStatus.ERROR

async def cleanup_job(job_id: str) -> None:
    job = jobs.get(job_id)
    if not job or not job.download_expiry:
        return
    delay = (job.download_expiry - datetime.utcnow()).total_seconds()
    if delay > 0:
        await asyncio.sleep(delay)
    try:
        if job.output_path and os.path.exists(job.output_path):
            os.remove(job.output_path)
        if os.path.exists(job.file_path):
            os.remove(job.file_path)
    except Exception as exc:
        logger.warning("Cleanup failed for %s: %s", job_id, exc)
    jobs.pop(job_id, None)

# ----------------- Routes ---------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "adsense_tag": adsense_script_tag(), "adsense_client_id": os.getenv("ADSENSE_CLIENT_ID", "")},
    )

@app.get("/terms", response_class=HTMLResponse)
async def terms(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("terms.html", {"request": request})

@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    job_id = str(uuid.uuid4())
    temp_path = TEMP_UPLOAD_DIR / f"upload_{job_id}{ext}"

    total = 0
    max_bytes = MAX_SIZE_GB * 1024 * 1024 * 1024
    with open(temp_path, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            total += len(chunk)
            if total > max_bytes:
                out.close()
                temp_path.unlink(missing_ok=True)
                raise HTTPException(400, "File exceeds 2GB limit")

    duration, _, _ = await asyncio.to_thread(probe_info, str(temp_path))
    if duration > MAX_DURATION_SEC:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    try:
        pricing = pick_tier(int(max(duration, 0)), total)
    except ValueError as exc:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(400, str(exc)) from exc

    job = Job(job_id, str(temp_path), duration, total, pricing)
    jobs[job_id] = job

    return JSONResponse({
        "job_id": job_id,
        "duration_sec": duration,
        "size_bytes": total,
        "tier": pricing["tier"],
        "price": pricing["price"],  # Gmail base (front-end adjusts per provider)
        "max_length_min": pricing["max_length_min"],
        "max_size_mb": pricing["max_size_mb"],
    })

@app.post("/checkout")
async def checkout(
    request: Request,
    job_id: str = Form(...),
    provider: str = Form(...),
    priority: bool = Form(False),
    transcript: bool = Form(False),
    email: Optional[str] = Form(None),
) -> JSONResponse:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(400, "Invalid job ID")
    if provider not in PROVIDER_TARGETS_MB:
        raise HTTPException(400, "Unknown email provider")

    job.provider = provider
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = (email or "").strip() or None
    job.target_size_mb = PROVIDER_TARGETS_MB[provider]

    tier = int(job.pricing["tier"])
    base = float(PROVIDER_PRICING[provider][tier - 1])
    upsell = (0.75 if job.priority else 0) + (1.50 if job.transcript else 0)
    total = round(base + upsell, 2)

    metadata = {
        "job_id": job_id,
        "provider": provider,
        "priority": str(job.priority),
        "transcript": str(job.transcript),
        "email": job.email or "",
        "target_size_mb": str(job.target_size_mb),
        "tier": str(tier),
        "base_price": str(base),
    }

    base_url = os.getenv("PUBLIC_BASE_URL", "").strip() or str(request.base_url).rstrip("/")
    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": f"MailSized compression (Tier {tier})"},
                "unit_amount": int(round(total * 100)),
            },
            "quantity": 1,
        }],
        success_url=f"{base_url}/?paid=1&job_id={job_id}",
        cancel_url=f"{base_url}/?canceled=1&job_id={job_id}",
        metadata=metadata,
    )
    return JSONResponse({"checkout_url": session.url, "session_id": session.id})

@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("Stripe-Signature", "")
    secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    if not secret:
        logger.error("STRIPE_WEBHOOK_SECRET not set")
        return JSONResponse(status_code=400, content={"detail": "Webhook secret not configured"})
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, secret)
    except Exception as exc:
        logger.warning("Stripe webhook signature verification failed: %s", exc)
        return JSONResponse(status_code=400, content={"detail": "Bad signature"})

    if event["type"] == "checkout.session.completed":
        data = event["data"]["object"]
        meta = data.get("metadata", {}) or {}
        job_id = meta.get("job_id")
        job = jobs.get(job_id)

        if job:
            job.provider = meta.get("provider") or job.provider
            job.priority = (meta.get("priority") in {"True", "true"})
            job.transcript = (meta.get("transcript") in {"True", "true"})
            email = (meta.get("email") or "").strip()
            job.email = email or job.email
            try:
                if meta.get("target_size_mb"):
                    job.target_size_mb = int(meta["target_size_mb"])
            except Exception:
                pass

            job.status = JobStatus.QUEUED
            asyncio.create_task(run_job(job))
            logger.info("Started job %s after Stripe payment", job_id)
        else:
            logger.warning("Webhook for unknown job_id=%s", job_id)

    return {"received": True}

@app.get("/events/{job_id}")
async def job_events(job_id: str):
    async def event_gen(jid: str):
        last_status = None
        last_pct = -1.0
        while True:
            job = jobs.get(jid)
            if not job:
                yield f"data: {json.dumps({'status': JobStatus.ERROR, 'message': 'Job not found'})}\n\n"
                break

            payload: Dict[str, Any] = {"status": job.status, "percent": round(job.progress_pct, 1)}

            # Always stream when percentage changes by >= 1% or status changes
            if job.status != last_status or (job.progress_pct - last_pct) >= 1.0:
                if job.status == JobStatus.DONE and job.download_url:
                    payload["download_url"] = job.download_url
                yield f"data: {json.dumps(payload)}\n\n"
                last_status = job.status
                last_pct = job.progress_pct
                if job.status in {JobStatus.DONE, JobStatus.ERROR}:
                    break

            await asyncio.sleep(0.5)

    return StreamingResponse(event_gen(job_id), media_type="text/event-stream")

@app.get("/download/{job_id}")
async def download(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != JobStatus.DONE or not job.output_path:
        raise HTTPException(400, "File not ready")
    if job.download_expiry and datetime.utcnow() > job.download_expiry:
        raise HTTPException(410, "Download link expired")
    if not os.path.exists(job.output_path):
        raise HTTPException(404, "File not found")
    return FileResponse(job.output_path, filename=f"compressed_video_{job.job_id}.mp4", media_type="video/mp4")

@app.get("/healthz")
async def health() -> Dict[str, str]:
    return {"status": "ok"}

if __name__ == "__main__":  # pragma: no cover
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
