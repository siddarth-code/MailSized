"""
MailSized ASGI app (FastAPI)

- Serves templates from app/templates and static from app/static
- Upload → Stripe pay → webhook -> FFmpeg 2-pass compression -> download
- Live progress via Server-Sent Events (/events/{job_id})
- Mailgun/SMTP notification
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Optional

import requests
import stripe
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# -------------------------
# Paths & config
# -------------------------

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailsized")

# project/app layout
APP_DIR = Path(__file__).resolve().parent                 # app/
ROOT_DIR = APP_DIR.parent                                 # project root
TEMPLATES_DIR = APP_DIR / "templates"
STATIC_DIR = APP_DIR / "static"
BIN_DIR = ROOT_DIR / "bin"                                # ffmpeg & ffprobe installed by build.sh

FFMPEG = str(BIN_DIR / "ffmpeg")
FFPROBE = str(BIN_DIR / "ffprobe")

# temp uploads dir (Render has write access under /opt/render/project/src)
TEMP_UPLOAD_DIR = Path(os.environ.get("TEMP_UPLOAD_DIR", ROOT_DIR / "temp_uploads"))
TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Stripe
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "").strip()

# Limits
MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi"}

# Attachment targets (MB)
PROVIDER_TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}

# Prices by provider and tier (≤5/≤10/≤20 min)
PROVIDER_PRICING = {
    "gmail":   [1.99, 2.99, 4.99],
    "outlook": [2.19, 3.29, 4.99],
    "other":   [2.49, 3.99, 5.49],
}

# -------------------------
# Helpers
# -------------------------

def adsense_script_tag() -> str:
    enabled = os.getenv("ENABLE_ADSENSE", "false").lower() == "true"
    consent = os.getenv("CONSENT_GIVEN", "false").lower() == "true"
    client = os.getenv("ADSENSE_CLIENT_ID", "").strip()
    if not (enabled and consent and client):
        return ""
    return (
        f'<script async '
        f'src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={client}" '
        f'crossorigin="anonymous"></script>'
    )

def _bytes_to_mb(b: int) -> float:
    return b / (1024 * 1024)

def pick_tier(duration_sec: int, size_bytes: int) -> Dict[str, Any]:
    minutes = duration_sec / 60
    mb = _bytes_to_mb(size_bytes)
    # Your caps: ≤500MB / ≤1GB / ≤2GB
    if minutes <= 5 and mb <= 500:
        return {"tier": 1, "max_length_min": 5, "max_size_mb": 500}
    if minutes <= 10 and mb <= 1024:
        return {"tier": 2, "max_length_min": 10, "max_size_mb": 1024}
    if minutes <= 20 and mb <= 2048:
        return {"tier": 3, "max_length_min": 20, "max_size_mb": 2048}
    raise ValueError("Video exceeds allowed limits (≤20 min, ≤2 GB).")

async def ffprobe_duration(path: Path) -> float:
    try:
        c = await asyncio.create_subprocess_exec(
            FFPROBE, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await c.communicate()
        return float(out.decode().strip())
    except Exception as e:
        log.warning("ffprobe failed: %s", e)
        return 0.0

def compute_2pass_bitrates(target_mb: int, duration_sec: float) -> tuple[int, int, int]:
    """
    Return (total_kbps, video_kbps, audio_kbps).
    Use simple envelope: reserve ~80 kbps for audio (LC-AAC), rest to video.
    """
    if duration_sec <= 0:
        duration_sec = 1
    target_bits = target_mb * 8_000_000  # ~8e6 bits per MB
    total_kbps = max(120, int(target_bits / duration_sec / 1000))
    audio_kbps = 80
    video_kbps = max(100, total_kbps - audio_kbps)
    return total_kbps, video_kbps, audio_kbps

TIME_RE = re.compile(r"time=(\d+):(\d+):(\d+)\.(\d+)")

def parse_ffmpeg_time(line: str) -> Optional[float]:
    m = TIME_RE.search(line)
    if not m:
        return None
    hh, mm, ss, ms = m.groups()
    return (int(hh) * 3600) + (int(mm) * 60) + int(ss) + int(ms) / 100.0

# -------------------------
# Job model
# -------------------------

class JobStatus:
    QUEUED = "queued"
    PROCESSING = "processing"   # analyzing/probing
    COMPRESSING = "compressing" # ffmpeg running
    FINALIZING = "finalizing"
    DONE = "done"
    ERROR = "error"

class Job:
    def __init__(self, job_id: str, in_path: Path, duration: float, size_bytes: int, tier: int):
        self.job_id = job_id
        self.in_path = in_path
        self.duration = duration
        self.size_bytes = size_bytes
        self.tier = tier

        self.provider: str = "gmail"
        self.priority: bool = False
        self.transcript: bool = False
        self.email: Optional[str] = None
        self.target_size_mb: int = PROVIDER_TARGETS_MB["gmail"]

        self.status: str = JobStatus.QUEUED
        self.progress: int = 0
        self.message: str = ""
        self.out_path: Optional[Path] = None

        self.created_at = datetime.utcnow()
        self.download_expiry: Optional[datetime] = None

    @property
    def download_url(self) -> Optional[str]:
        if self.status != JobStatus.DONE or not self.out_path:
            return None
        return f"/download/{self.job_id}"

jobs: Dict[str, Job] = {}

# -------------------------
# Compression & email
# -------------------------

async def compress_with_ffmpeg(job: Job) -> None:
    """
    FFmpeg 2-pass ABR to hit provider target. Updates job.progress by parsing stderr time.
    """
    job.status = JobStatus.COMPRESSING
    job.progress = 2

    # Where to write temp outputs
    out_basename = f"compressed_{job.job_id}.mp4"
    passlog = TEMP_UPLOAD_DIR / f"ffpass_{job.job_id}"
    out_path = TEMP_UPLOAD_DIR / out_basename

    _tot_kbps, v_kbps, a_kbps = compute_2pass_bitrates(job.target_size_mb, job.duration)
    log.info("2-pass target ~%s MB: v=%skbps a=%skbps", job.target_size_mb, v_kbps, a_kbps)

    # First pass
    cmd1 = [
        FFMPEG, "-y",
        "-i", str(job.in_path),
        "-c:v", "libx264", "-b:v", f"{v_kbps}k",
        "-pass", "1", "-passlogfile", str(passlog),
        "-preset", "veryfast",
        "-c:a", "aac", "-b:a", f"{a_kbps}k",
        "-f", "mp4", "/dev/null",
    ]
    # Second pass
    cmd2 = [
        FFMPEG, "-y",
        "-i", str(job.in_path),
        "-c:v", "libx264", "-b:v", f"{v_kbps}k",
        "-pass", "2", "-passlogfile", str(passlog),
        "-preset", "veryfast",
        "-c:a", "aac", "-b:a", f"{a_kbps}k",
        str(out_path),
    ]

    async def _run_and_track(cmd: list[str]) -> None:
        # Pipe stderr to parse time=?
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        assert proc.stderr
        async for raw in proc.stderr:
            line = raw.decode(errors="ignore").strip()
            t = parse_ffmpeg_time(line)
            if t is not None and job.duration > 0:
                pct = int(max(2, min(98, (t / job.duration) * 100)))
                # avoid regress
                if pct > job.progress:
                    job.progress = pct
        rc = await proc.wait()
        if rc != 0:
            raise RuntimeError(f"FFmpeg exited with code {rc}")

    try:
        await _run_and_track(cmd1)
        # reset progress floor between passes
        job.progress = max(job.progress, 30)
        await _run_and_track(cmd2)
    finally:
        # Clean up ffmpeg pass logs (they create files with extensions .log, .mbtree, etc)
        for p in TEMP_UPLOAD_DIR.glob(f"{passlog.name}*"):
            with contextlib.suppress(Exception):
                p.unlink()

    job.out_path = out_path

async def send_email(recipient: str, download_url: str) -> None:
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your compressed video is ready"
    body = f"Your video is ready for the next 30 minutes:\n{download_url}"

    # Try Mailgun first
    mg_api_key = os.getenv("MAILGUN_API_KEY", "").strip()
    mg_domain = os.getenv("MAILGUN_DOMAIN", "").strip()
    if mg_api_key and mg_domain and recipient:
        try:
            resp = requests.post(
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
            resp.raise_for_status()
            log.info("Email sent via Mailgun to %s", recipient)
            return
        except Exception as e:
            log.warning("Mailgun failed: %s", e)

    # SMTP fallback
    host = os.getenv("EMAIL_SMTP_HOST", "")
    port = int(os.getenv("EMAIL_SMTP_PORT", "0") or 0)
    username = os.getenv("EMAIL_USERNAME", "")
    password = os.getenv("EMAIL_PASSWORD", "")
    if not (host and port and username and password and recipient):
        log.info("No SMTP creds; skipping email.")
        return

    import smtplib
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart

    msg = MIMEMultipart()
    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = subject
    msg["Auto-Submitted"] = "auto-generated"
    msg["X-Auto-Response-Suppress"] = "All"
    msg["Reply-To"] = "no-reply@mailsized.com"
    msg.attach(MIMEText(body, "plain"))

    try:
        with smtplib.SMTP(host, port, timeout=15) as s:
            # STARTTLS first (fixes 530 “Must issue a STARTTLS command first”)
            s.starttls()
            s.login(username, password)
            s.send_message(msg)
        log.info("Email sent via SMTP to %s", recipient)
    except Exception as e:
        log.warning("SMTP failed: %s", e)

async def run_job(job: Job) -> None:
    try:
        job.status = JobStatus.PROCESSING
        job.progress = max(job.progress, 2)

        # 2-pass compression (or CloudConvert if you flip it back)
        await compress_with_ffmpeg(job)

        job.status = JobStatus.FINALIZING
        job.progress = max(job.progress, 99)

        ttl_min = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
        job.download_expiry = datetime.utcnow() + timedelta(minutes=ttl_min)

        job.status = JobStatus.DONE
        job.progress = 100

        # notify
        if job.email:
            await send_email(job.email, job.download_url or "")

        # schedule cleanup
        asyncio.create_task(cleanup_job(job.job_id))
    except Exception as e:
        log.exception("Job %s failed: %s", job.job_id, e)
        job.status = JobStatus.ERROR
        job.message = str(e)

async def cleanup_job(job_id: str) -> None:
    job = jobs.get(job_id)
    if not job or not job.download_expiry:
        return
    delay = (job.download_expiry - datetime.utcnow()).total_seconds()
    if delay > 0:
        await asyncio.sleep(delay)
    try:
        if job.out_path and job.out_path.exists():
            job.out_path.unlink()
        if job.in_path.exists():
            job.in_path.unlink()
    finally:
        jobs.pop(job_id, None)
        log.info("Cleaned up job %s", job_id)

# -------------------------
# FastAPI app
# -------------------------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static and templates from app/*
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "adsense_tag": adsense_script_tag(),
            "adsense_client_id": os.getenv("ADSENSE_CLIENT_ID", "").strip(),
        },
    )

@app.get("/terms", response_class=HTMLResponse)
async def terms(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("terms.html", {"request": request})

# -------------------------
# API routes
# -------------------------

@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    job_id = str(uuid.uuid4())
    temp_path = TEMP_UPLOAD_DIR / f"upload_{job_id}{ext}"

    # save chunked & enforce 2GB
    max_bytes = MAX_SIZE_GB * 1024 * 1024 * 1024
    written = 0
    with temp_path.open("wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            written += len(chunk)
            if written > max_bytes:
                out.close()
                temp_path.unlink(missing_ok=True)
                raise HTTPException(400, "File exceeds 2 GB limit")

    duration = await ffprobe_duration(temp_path)
    if duration > MAX_DURATION_SEC:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    try:
        tier_info = pick_tier(int(duration), written)
    except ValueError as e:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(400, str(e)) from e

    # Gmail base price for display; client swaps provider
    base_price = PROVIDER_PRICING["gmail"][tier_info["tier"] - 1]

    job = Job(job_id, temp_path, duration, written, tier_info["tier"])
    jobs[job_id] = job

    return JSONResponse(
        {
            "job_id": job_id,
            "duration_sec": duration,
            "size_bytes": written,
            "tier": tier_info["tier"],
            "price": base_price,
            "max_length_min": tier_info["max_length_min"],
            "max_size_mb": tier_info["max_size_mb"],
        }
    )

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
        raise HTTPException(400, "Unknown provider")

    job.provider = provider
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = (email or "").strip() or None
    job.target_size_mb = PROVIDER_TARGETS_MB[provider]

    tier = job.tier
    base = PROVIDER_PRICING[provider][tier - 1]
    upsells = (0.75 if job.priority else 0) + (1.50 if job.transcript else 0)
    total = round(base + upsells, 2)
    amount_cents = int(round(total * 100))

    meta = {
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
    success_url = f"{base_url}/?paid=1&job_id={job_id}"
    cancel_url = f"{base_url}/?canceled=1&job_id={job_id}"

    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[
            {
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": f"MailSized compression (Tier {tier})"},
                    "unit_amount": amount_cents,
                },
                "quantity": 1,
            }
        ],
        success_url=success_url,
        cancel_url=cancel_url,
        metadata=meta,
    )
    return JSONResponse({"checkout_url": session.url, "session_id": session.id})

@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("Stripe-Signature", "")
    secret = os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()
    if not secret:
        log.error("STRIPE_WEBHOOK_SECRET not set")
        return JSONResponse(status_code=400, content={"detail": "Webhook secret not configured"})

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, secret)
    except Exception as e:
        log.warning("Stripe webhook verification failed: %s", e)
        return JSONResponse(status_code=400, content={"detail": "Bad signature"})

    if event["type"] == "checkout.session.completed":
        data = event["data"]["object"]
        meta = data.get("metadata") or {}
        job_id = meta.get("job_id")
        job = jobs.get(job_id)
        if job:
            # Restore user selections from metadata
            job.provider = meta.get("provider", job.provider)
            job.priority = (meta.get("priority") in {"True", "true", "1"})
            job.transcript = (meta.get("transcript") in {"True", "true", "1"})
            if meta.get("email"):
                job.email = meta["email"].strip() or None
            try:
                if meta.get("target_size_mb"):
                    job.target_size_mb = int(meta["target_size_mb"])
            except Exception:
                pass

            job.status = JobStatus.QUEUED
            job.progress = 2
            asyncio.create_task(run_job(job))
            log.info("Started job %s after Stripe payment", job_id)
        else:
            log.warning("Webhook for unknown job_id=%s", job_id)

    return {"received": True}

@app.get("/events/{job_id}")
async def events(job_id: str):
    async def stream():
        last = None
        while True:
            job = jobs.get(job_id)
            if not job:
                yield f"data: {json.dumps({'status': JobStatus.ERROR, 'message': 'Job not found'})}\n\n"
                break

            payload: Dict[str, Any] = {
                "status": job.status,
                "progress": job.progress,
                "message": job.message,
            }
            if job.status == JobStatus.DONE and job.download_url:
                payload["download_url"] = job.download_url

            # only send on changes or every ~2 sec while compressing
            text = json.dumps(payload)
            if text != last or job.status == JobStatus.COMPRESSING:
                yield f"data: {text}\n\n"
                last = text

            if job.status in {JobStatus.DONE, JobStatus.ERROR}:
                break

            await asyncio.sleep(1)

    return StreamingResponse(stream(), media_type="text/event-stream")

@app.get("/download/{job_id}")
async def download(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != JobStatus.DONE or not job.out_path:
        raise HTTPException(400, "File not ready")
    if job.download_expiry and datetime.utcnow() > job.download_expiry:
        raise HTTPException(410, "Download link expired")
    if not job.out_path.exists():
        raise HTTPException(404, "File missing")

    return FileResponse(
        str(job.out_path),
        filename=f"compressed_video_{job.job_id}.mp4",
        media_type="video/mp4",
    )

@app.get("/healthz")
async def health() -> Dict[str, str]:
    ok = Path(FFMPEG).exists() and Path(FFPROBE).exists()
    return {"status": "ok" if ok else "ffmpeg-missing"}

# -------------------------
# Entrypoint (local)
# -------------------------

if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        reload=bool(os.getenv("DEV_RELOAD")),
    )
