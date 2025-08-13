"""
MailSized – FastAPI app (upload → Stripe pay → compress → download) with
provider pricing + async ffmpeg sized to email attachment targets.

Key fixes vs prior:
- Async, non-blocking ffmpeg pipeline (no event loop stall → fewer 502s)
- Real size targeting using 2-pass ABR (x264) based on provider MB cap
- Constrained resource usage (threads=1) for Render Hobby
- HEAD / health handling and clearer logging
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

import requests
import stripe
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# -------------------- Config --------------------

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailsized")

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

BASE_DIR = os.path.dirname(__file__)

# Filesystem paths (Render-safe)
TEMP_UPLOAD_DIR = (
    "/opt/render/project/src/temp_uploads"
    if "RENDER" in os.environ
    else os.path.join(BASE_DIR, "temp_uploads")
)
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)

# ffmpeg binaries we downloaded to ./bin via build.sh
FFMPEG = os.getenv("FFMPEG_PATH", "/opt/render/project/src/bin/ffmpeg")
FFPROBE = os.getenv("FFPROBE_PATH", "/opt/render/project/src/bin/ffprobe")

# Limits / pricing
MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi"}

# Provider attachment targets (MB) — our compression goal
PROVIDER_TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}

# Provider base pricing by tier (≤5, ≤10, ≤20 min)
PROVIDER_PRICING = {
    "gmail":   [1.99, 2.99, 4.49],
    "outlook": [2.19, 3.29, 4.99],
    "other":   [2.49, 3.99, 5.49],
}

PUBLIC_BASE_URL = (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/")

# -------------------- Helpers --------------------

def adsense_script_tag() -> str:
    enabled = os.getenv("ENABLE_ADSENSE", "false").lower() == "true"
    consent = os.getenv("CONSENT_GIVEN", "false").lower() == "true"
    client = os.getenv("ADSENSE_CLIENT_ID", "").strip()
    if not (enabled and consent and client):
        return ""
    return (f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'
            f'?client={client}" crossorigin="anonymous"></script>')


def calculate_pricing(duration_sec: int, file_size_bytes: int) -> Dict[str, Any]:
    """Pick tier based on duration and file size caps (≤500MB/≤1GB/≤2GB)."""
    minutes = duration_sec / 60
    mb_size = file_size_bytes / (1024 * 1024)

    if minutes <= 5 and mb_size <= 500:
        tier, price, max_len, max_mb = 1, 1.99, 5, 500
    elif minutes <= 10 and mb_size <= 1024:
        tier, price, max_len, max_mb = 2, 2.99, 10, 1024
    elif minutes <= 20 and mb_size <= 2048:
        tier, price, max_len, max_mb = 3, 4.99, 20, 2048
    else:
        raise ValueError("Video exceeds allowed limits for all tiers.")

    return {
        "tier": tier,
        "price": round(price, 2),  # Gmail base for that tier; provider swaps on UI
        "max_length_min": max_len,
        "max_size_mb": max_mb,
    }


async def probe_duration(file_path: str) -> float:
    """Return duration (seconds) using ffprobe; 0.0 on failure."""
    try:
        p = await asyncio.create_subprocess_exec(
            FFPROBE,
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            file_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await p.communicate()
        return float((out or b"0").decode().strip() or "0")
    except Exception as exc:
        log.warning("ffprobe failed: %s", exc)
        return 0.0


def compute_bitrates_for_target(duration_sec: float, target_mb: int) -> tuple[int, int]:
    """
    Compute (video_kbps, audio_kbps) for a **target total size**.

    We budget a fixed audio bitrate and muxing overhead, then assign the rest to video.
    """
    # Total target bits
    total_bits = target_mb * 1024 * 1024 * 8
    # Conservative audio budget (mono/low stereo) to save headroom
    audio_kbps = 80  # tweakable
    overhead = 0.05  # 5% container overhead
    # Bits available for video after audio+overhead
    duration = max(1.0, float(duration_sec))
    video_bits_available = total_bits * (1.0 - overhead) - (audio_kbps * 1000 * duration)
    video_kbps = max(150, int(video_bits_available / 1000 / duration))
    # Guardrails
    video_kbps = min(video_kbps, 2500)  # cap for short clips
    return video_kbps, audio_kbps


async def ffmpeg_two_pass(
    src: str, dst: str, duration_sec: float, target_mb: int
) -> None:
    """
    2-pass ABR to hit a size close to provider's cap.
    Constrain threads to reduce memory spikes on Hobby.
    """
    v_kbps, a_kbps = compute_bitrates_for_target(duration_sec, target_mb)
    log.info("2-pass target ~%d MB: v=%dkbps a=%dkbps", target_mb, v_kbps, a_kbps)

    passlog = os.path.join(TEMP_UPLOAD_DIR, f"ffpass_{uuid.uuid4().hex}")
    common = [
        "-y", "-hide_banner", "-loglevel", "error",
        "-threads", "1",
        "-i", src,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-movflags", "+faststart",
    ]

    # pass 1 (no audio, null mux)
    p1 = await asyncio.create_subprocess_exec(
        FFMPEG, *common,
        "-b:v", f"{v_kbps}k",
        "-pass", "1",
        "-passlogfile", passlog,
        "-an",
        "-f", "mp4",
        os.devnull,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err1 = await p1.communicate()
    if p1.returncode != 0:
        raise RuntimeError(f"ffmpeg pass1 failed: {err1.decode()}")

    # pass 2 (with audio)
    p2 = await asyncio.create_subprocess_exec(
        FFMPEG, *common,
        "-b:v", f"{v_kbps}k",
        "-pass", "2",
        "-passlogfile", passlog,
        "-c:a", "aac",
        "-b:a", f"{a_kbps}k",
        dst,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err2 = await p2.communicate()
    # Clean pass logs
    for ext in (".log", ".mbtree"):
        try:
            os.remove(passlog + ext)
        except FileNotFoundError:
            pass
    if p2.returncode != 0:
        raise RuntimeError(f"ffmpeg pass2 failed: {err2.decode()}")


# -------------------- Job model --------------------

class JobStatus:
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPRESSING = "compressing"
    FINALIZING = "finalizing"
    DONE = "done"
    ERROR = "error"


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
        self.created_at = datetime.utcnow()
        self.download_expiry: Optional[datetime] = None

    @property
    def download_url(self) -> Optional[str]:
        if self.status != JobStatus.DONE or not self.output_path:
            return None
        return f"/download/{self.job_id}"


jobs: Dict[str, Job] = {}

# -------------------- Email --------------------

async def send_email(recipient: str, download_url: str) -> None:
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your compressed video is ready"
    body = f"Your video is ready for the next 30 minutes:\n{download_url}"

    mg_api_key = os.getenv("MAILGUN_API_KEY")
    mg_domain = os.getenv("MAILGUN_DOMAIN")
    if mg_api_key and mg_domain and recipient:
        def _send_mailgun():
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
                timeout=10,
            )
            r.raise_for_status()

        try:
            await asyncio.to_thread(_send_mailgun)
            log.info("Email sent to %s via Mailgun", recipient)
            return
        except Exception as exc:
            log.warning("Mailgun failed: %s", exc)

    host = os.getenv("EMAIL_SMTP_HOST")
    port = os.getenv("EMAIL_SMTP_PORT")
    username = os.getenv("EMAIL_USERNAME")
    password = os.getenv("EMAIL_PASSWORD")
    if not (host and port and username and password and recipient):
        log.info("Email skipped: no Mailgun or SMTP credentials")
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
        with smtplib.SMTP(host, int(port)) as s:
            s.starttls()
            s.login(username, password)
            s.send_message(msg)
        log.info("Email sent to %s via SMTP", recipient)
    except Exception as exc:
        log.warning("SMTP failed: %s", exc)

# -------------------- Job runner --------------------

async def run_job(job: Job) -> None:
    try:
        job.status = JobStatus.PROCESSING
        await asyncio.sleep(0.5)

        job.status = JobStatus.COMPRESSING
        out_name = f"compressed_{job.job_id}.mp4"
        job.output_path = os.path.join(TEMP_UPLOAD_DIR, out_name)

        target_mb = int(job.target_size_mb or PROVIDER_TARGETS_MB.get(job.provider or "gmail", 25))
        await ffmpeg_two_pass(job.file_path, job.output_path, job.duration, target_mb)

        job.status = JobStatus.FINALIZING
        await asyncio.sleep(0.5)

        ttl = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
        job.download_expiry = datetime.utcnow() + timedelta(minutes=ttl)
        job.status = JobStatus.DONE

        if job.email:
            await send_email(job.email, job.download_url or "")

        asyncio.create_task(cleanup_job(job.job_id))
    except Exception as exc:
        log.exception("Job %s failed: %s", job.job_id, exc)
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
        log.warning("Cleanup error for %s: %s", job_id, exc)
    jobs.pop(job_id, None)
    log.info("Cleaned up job %s", job_id)

# -------------------- FastAPI app --------------------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # you can tighten to mailsized.com later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "adsense_tag": adsense_script_tag(), "adsense_client_id": os.getenv("ADSENSE_CLIENT_ID", "")},
    )

# Render proxy sometimes sends HEAD /
@app.head("/")
async def head_root() -> JSONResponse:
    return JSONResponse({"ok": True})

@app.get("/terms", response_class=HTMLResponse)
async def terms(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("terms.html", {"request": request})

@app.post("/upload")
async def upload_video(file: UploadFile = File(...)) -> JSONResponse:
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    job_id = str(uuid.uuid4())
    temp_path = os.path.join(TEMP_UPLOAD_DIR, f"upload_{job_id}{ext}")
    total_bytes = 0
    max_bytes = MAX_SIZE_GB * 1024 * 1024 * 1024

    with open(temp_path, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            total_bytes += len(chunk)
            if total_bytes > max_bytes:
                out.close()
                os.remove(temp_path)
                raise HTTPException(400, "File exceeds 2GB limit")

    duration = await probe_duration(temp_path)
    if duration > MAX_DURATION_SEC:
        os.remove(temp_path)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    try:
        pricing = calculate_pricing(int(duration), total_bytes)
    except ValueError as exc:
        os.remove(temp_path)
        raise HTTPException(400, str(exc))

    job = Job(job_id, temp_path, duration, total_bytes, pricing)
    jobs[job_id] = job

    return JSONResponse(
        {
            "job_id": job_id,
            "duration_sec": duration,
            "size_bytes": total_bytes,
            "tier": pricing["tier"],
            "price": pricing["price"],
            "max_length_min": pricing["max_length_min"],
            "max_size_mb": pricing["max_size_mb"],
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
        raise HTTPException(400, "Unknown email provider")

    job.provider = provider
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = (email or "").strip() or None
    job.target_size_mb = PROVIDER_TARGETS_MB[provider]

    tier = int(job.pricing["tier"])
    base = float(PROVIDER_PRICING[provider][tier - 1])
    upsells = (0.75 if job.priority else 0) + (1.50 if job.transcript else 0)
    total = round(base + upsells, 2)
    amount_cents = int(round(total * 100))

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

    base_url = PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
    success_url = f"{base_url}/?paid=1&job_id={job_id}"
    cancel_url = f"{base_url}/?canceled=1&job_id={job_id}"

    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {
                "currency": "usd",
                "product_data": {"name": f"MailSized compression (Tier {tier})"},
                "unit_amount": amount_cents,
            },
            "quantity": 1,
        }],
        success_url=success_url,
        cancel_url=cancel_url,
        metadata=metadata,
    )
    return JSONResponse({"checkout_url": session.url, "session_id": session.id})

@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("Stripe-Signature", "")
    secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    if not secret:
        log.error("STRIPE_WEBHOOK_SECRET not set")
        return JSONResponse(status_code=400, content={"detail": "Webhook secret not configured"})
    try:
        event = stripe.Webhook.construct_event(payload, sig_header, secret)
    except Exception as exc:
        log.warning("Stripe webhook verification failed: %s", exc)
        return JSONResponse(status_code=400, content={"detail": "Bad signature"})

    if event["type"] == "checkout.session.completed":
        obj = event["data"]["object"]
        meta = obj.get("metadata", {}) or {}
        job_id = meta.get("job_id")
        job = jobs.get(job_id)
        if job:
            job.provider = meta.get("provider") or job.provider
            job.priority = (meta.get("priority") or "").lower() == "true"
            job.transcript = (meta.get("transcript") or "").lower() == "true"
            email = (meta.get("email") or "").strip()
            job.email = email or job.email
            try:
                if meta.get("target_size_mb"):
                    job.target_size_mb = int(meta["target_size_mb"])
            except Exception:
                pass

            job.status = JobStatus.QUEUED
            asyncio.create_task(run_job(job))
            log.info("Started job %s after Stripe payment", job_id)
        else:
            log.warning("Webhook for unknown job_id=%s", job_id)

    return {"received": True}

@app.get("/events/{job_id}")
async def job_events(job_id: str):
    async def gen(jid: str):
        last = None
        while True:
            job = jobs.get(jid)
            if not job:
                yield f"data: {json.dumps({'status': JobStatus.ERROR, 'message': 'Job not found'})}\n\n"
                break
            if job.status != last:
                payload: Dict[str, Any] = {"status": job.status}
                if job.status == JobStatus.DONE and job.download_url:
                    payload["download_url"] = job.download_url
                yield f"data: {json.dumps(payload)}\n\n"
                last = job.status
                if job.status in {JobStatus.DONE, JobStatus.ERROR}:
                    break
            await asyncio.sleep(1)
    return StreamingResponse(gen(job_id), media_type="text/event-stream")

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

if __name__ == "__main__":  # local dev
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), reload=False)
