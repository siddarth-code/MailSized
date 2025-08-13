"""
MailSized — FastAPI app (app/main.py)

Workflow:
1) POST /upload -> save file, probe duration, decide tier, return job_id + tier + base gmail price
2) POST /checkout -> create Stripe Checkout for provider/tier (DO NOT start job)
3) Stripe -> /stripe/webhook (checkout.session.completed) -> start job
4) GET /events/{job_id} -> SSE for stepper
5) GET /download/{job_id} -> serve compressed file

Caps (your request): ≤500MB / ≤1GB / ≤2GB
Provider targets: Gmail=25MB, Outlook=20MB, Other=15MB
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
from typing import Any, Dict

import requests
import stripe
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ---------- Config & Globals ----------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mailsized")

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

BASE_DIR = os.path.dirname(__file__)
if "RENDER" in os.environ:
    TEMP_UPLOAD_DIR = "/opt/render/project/src/temp_uploads"
else:
    TEMP_UPLOAD_DIR = os.path.join(BASE_DIR, "temp_uploads")
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)

# Cleanup orphaned temp files on startup to protect disk quota
try:
    for name in os.listdir(TEMP_UPLOAD_DIR):
        p = os.path.join(TEMP_UPLOAD_DIR, name)
        if os.path.isfile(p):
            os.remove(p)
except Exception as _e:
    logger.warning("Startup cleanup warning: %s", _e)

# Global limits
MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi"}

# Provider attachment targets (MB) used to set compression goals
PROVIDER_TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}

# Provider-specific base prices by tier [tier1, tier2, tier3]
PROVIDER_PRICING = {
    "gmail": [1.99, 2.99, 4.99],
    "outlook": [2.19, 3.29, 4.99],
    "other": [2.49, 3.99, 5.49],
}

# ---------- Ads (optional) ----------

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

# ---------- Job Model ----------

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

        self.provider: str | None = None
        self.priority: bool = False
        self.transcript: bool = False
        self.email: str | None = None
        self.target_size_mb: int | None = None

        self.status: str = JobStatus.QUEUED
        self.output_path: str | None = None
        self.created_at = datetime.utcnow()
        self.download_expiry: datetime | None = None

    @property
    def download_url(self) -> str | None:
        if self.status != JobStatus.DONE or not self.output_path:
            return None
        return f"/download/{self.job_id}"


# In-memory registry
jobs: Dict[str, Job] = {}

# ---------- Helpers: probing & compression ----------

async def probe_duration(file_path: str) -> float:
    """Return duration (seconds) using ffprobe; 0.0 on failure."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        return float(result.stdout.strip())
    except Exception as exc:
        logger.warning("ffprobe failed: %s", exc)
        return 0.0


def _calc_target_bitrate_kbps(target_size_mb: int, duration_sec: float) -> tuple[int, int]:
    """
    Compute video+audio bitrate to hit a provider cap.
    Reserve ~5% container overhead; AAC audio 96–128 kbps depending on length.
    Returns (video_kbps, audio_kbps).
    """
    duration_sec = max(1.0, float(duration_sec))
    target_bits = target_size_mb * 1024 * 1024 * 8
    container_overhead = int(target_bits * 0.05)
    usable_bits = max(1, target_bits - container_overhead)

    audio_kbps = 128 if duration_sec >= 300 else 96
    audio_bits = int(audio_kbps * 1000 * duration_sec)

    video_bits = max(1, usable_bits - audio_bits)
    video_kbps = max(150, int(video_bits / duration_sec / 1000))
    video_kbps = min(video_kbps, 4000)  # sanity cap

    return video_kbps, audio_kbps


async def _run_ffmpeg_2pass(src: str, dst: str, video_kbps: int, audio_kbps: int) -> None:
    """Two-pass ABR with libx264 + AAC."""
    log_path = os.path.join(TEMP_UPLOAD_DIR, f"ffmpeg2pass_{uuid.uuid4().hex}")
    pass1 = [
        "ffmpeg", "-y",
        "-i", src,
        "-c:v", "libx264", "-b:v", f"{video_kbps}k",
        "-pass", "1", "-passlogfile", log_path,
        "-an",
        "-preset", "veryfast",
        "-movflags", "+faststart",
        "-f", "mp4", "/dev/null",
    ]
    pass2 = [
        "ffmpeg", "-y",
        "-i", src,
        "-c:v", "libx264", "-b:v", f"{video_kbps}k",
        "-pass", "2", "-passlogfile", log_path,
        "-c:a", "aac", "-b:a", f"{audio_kbps}k",
        "-preset", "veryfast",
        "-movflags", "+faststart",
        dst,
    ]
    try:
        subprocess.run(pass1, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(pass2, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    finally:
        for ext in (".log", ".log.mbtree"):
            p = f"{log_path}{ext}"
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass


async def compress_video(file_path: str, output_path: str, target_size_mb: int) -> None:
    """
    Compress to meet the provider cap using:
      1) Two‑pass ABR at computed bitrate
      2) If over, retry at 90%, then 80%
      3) If still over, CRF ladder 28 -> 30 -> 32
    """
    duration_sec = await probe_duration(file_path)
    if duration_sec <= 0:
        # Fallback when duration fails
        crf_cmd = [
            "ffmpeg", "-y", "-i", file_path,
            "-c:v", "libx264", "-crf", "30", "-preset", "veryfast",
            "-c:a", "aac", "-b:a", "96k",
            "-movflags", "+faststart",
            output_path,
        ]
        subprocess.run(crf_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return

    v_kbps, a_kbps = _calc_target_bitrate_kbps(target_size_mb, duration_sec)
    for scale in (1.00, 0.90, 0.80):
        try:
            await _run_ffmpeg_2pass(file_path, output_path, int(v_kbps * scale), a_kbps)
            final_mb = os.path.getsize(output_path) / (1024 * 1024)
            if final_mb <= (target_size_mb * 1.03):
                return
        except subprocess.CalledProcessError as e:
            logger.warning("ffmpeg ABR encode failed at scale %.2f: %s", scale, e)

    for crf in (28, 30, 32):
        try:
            crf_cmd = [
                "ffmpeg", "-y", "-i", file_path,
                "-c:v", "libx264", "-crf", str(crf), "-preset", "veryfast",
                "-c:a", "aac", "-b:a", f"{a_kbps}k",
                "-movflags", "+faststart",
                output_path,
            ]
            subprocess.run(crf_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            final_mb = os.path.getsize(output_path) / (1024 * 1024)
            if final_mb <= (target_size_mb * 1.03):
                return
        except subprocess.CalledProcessError as e:
            logger.warning("ffmpeg CRF=%s encode failed: %s", crf, e)

    # last attempt already sits in output_path; if it failed, copy as last resort
    if not os.path.exists(output_path):
        shutil.copy(file_path, output_path)

# ---------- Pricing ----------

def calculate_pricing(duration_sec: int, file_size_bytes: int) -> Dict[str, Any]:
    """
    Decide tier based on duration and size.
    Caps: ≤500MB / ≤1GB / ≤2GB
    Returns dict with tier (1-3), a base price (gmail tier price), and max caps.
    """
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
        "price": round(price, 2),  # base Gmail price for the tier
        "max_length_min": max_len,
        "max_size_mb": max_mb,
    }

# ---------- Email ----------

async def send_email(recipient: str, download_url: str) -> None:
    """Send email via Mailgun if configured; fall back to SMTP."""
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your compressed video is ready"
    body = f"Your video is ready for the next 30 minutes:\n{download_url}"

    mg_api_key = os.getenv("MAILGUN_API_KEY")
    mg_domain = os.getenv("MAILGUN_DOMAIN")
    if mg_api_key and mg_domain and recipient:
        def _send_mailgun():
            data = {
                "from": sender,
                "to": [recipient],
                "subject": subject,
                "text": body,
                "h:Auto-Submitted": "auto-generated",
                "h:X-Auto-Response-Suppress": "All",
                "h:Reply-To": "no-reply@mailsized.com",
            }
            r = requests.post(
                f"https://api.mailgun.net/v3/{mg_domain}/messages",
                auth=("api", mg_api_key),
                data=data,
                timeout=10,
            )
            r.raise_for_status()

        try:
            await asyncio.to_thread(_send_mailgun)
            logger.info("Email sent to %s via Mailgun", recipient)
            return
        except Exception as exc:
            logger.warning("Mailgun send failed: %s", exc)

    host = os.getenv("EMAIL_SMTP_HOST")
    port = os.getenv("EMAIL_SMTP_PORT")
    username = os.getenv("EMAIL_USERNAME")
    password = os.getenv("EMAIL_PASSWORD")
    if not (host and port and username and password and recipient):
        logger.info("Email not sent: no Mailgun or SMTP credentials set.")
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
        logger.info("Email sent to %s via SMTP", recipient)
    except Exception as exc:
        logger.warning("SMTP send failed: %s", exc)

# ---------- Job runner & cleanup ----------

async def run_job(job: Job) -> None:
    try:
        job.status = JobStatus.PROCESSING
        await asyncio.sleep(1)

        job.status = JobStatus.COMPRESSING
        output_filename = f"compressed_{job.job_id}.mp4"
        job.output_path = os.path.join(TEMP_UPLOAD_DIR, output_filename)
        await compress_video(job.file_path, job.output_path, job.target_size_mb or 25)

        job.status = JobStatus.FINALIZING
        await asyncio.sleep(1)

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
    logger.info("Cleaned up job %s", job_id)

# ---------- FastAPI App ----------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten later to production domain
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

@app.get("/terms", response_class=HTMLResponse)
async def terms(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("terms.html", {"request": request})

# ---------- Upload ----------

@app.post("/upload")
async def upload_video(file: UploadFile = File(...)) -> JSONResponse:
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    job_id = str(uuid.uuid4())
    temp_path = os.path.join(TEMP_UPLOAD_DIR, f"upload_{job_id}{ext}")
    total_bytes = 0

    with open(temp_path, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            total_bytes += len(chunk)
            if total_bytes > MAX_SIZE_GB * 1024 * 1024 * 1024:
                out.close()
                os.remove(temp_path)
                raise HTTPException(400, "File exceeds 2GB limit")

    duration_sec = await probe_duration(temp_path)
    if duration_sec > MAX_DURATION_SEC:
        os.remove(temp_path)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    try:
        pricing = calculate_pricing(int(duration_sec), total_bytes)
    except ValueError as exc:
        os.remove(temp_path)
        raise HTTPException(400, str(exc)) from exc

    job = Job(job_id, temp_path, duration_sec, total_bytes, pricing)
    jobs[job_id] = job

    return JSONResponse(
        {
            "job_id": job_id,
            "duration_sec": duration_sec,
            "size_bytes": total_bytes,
            "tier": pricing["tier"],
            "price": pricing["price"],  # gmail base; UI swaps provider price
            "max_length_min": pricing["max_length_min"],
            "max_size_mb": pricing["max_size_mb"],
        }
    )

# ---------- Checkout (Stripe redirect) ----------

@app.post("/checkout")
async def checkout(
    request: Request,
    job_id: str = Form(...),
    provider: str = Form(...),
    priority: bool = Form(False),
    transcript: bool = Form(False),
    email: str | None = Form(None),
) -> JSONResponse:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(400, "Invalid job ID")

    if provider not in PROVIDER_TARGETS_MB:
        raise HTTPException(400, "Unknown email provider")

    # persist selections
    job.provider = provider
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = (email or "").strip() or None
    job.target_size_mb = PROVIDER_TARGETS_MB[provider]

    # provider base price by tier
    tier = int(job.pricing["tier"])  # 1..3
    provider_prices = PROVIDER_PRICING[provider]
    base = float(provider_prices[tier - 1])

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
        metadata=metadata,
    )

    # NOTE: Do NOT start the job here; webhook will.
    return JSONResponse({"checkout_url": session.url, "session_id": session.id})

# ---------- Stripe webhook ----------

@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("Stripe-Signature", "")
    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")

    if not webhook_secret:
        logger.error("STRIPE_WEBHOOK_SECRET not set")
        return JSONResponse(status_code=400, content={"detail": "Webhook secret not configured"})

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
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
            job.priority = (meta.get("priority") in ("True", "true"))
            job.transcript = (meta.get("transcript") in ("True", "true"))
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
            logger.warning("Webhook received for unknown job_id=%s", job_id)

    return {"received": True}

# ---------- SSE events ----------

@app.get("/events/{job_id}")
async def job_events(job_id: str):
    async def event_generator(jid: str):
        last_status = None
        while True:
            job = jobs.get(jid)
            if not job:
                yield f"data: {json.dumps({'status': JobStatus.ERROR, 'message': 'Job not found'})}\n\n"
                break

            if job.status != last_status:
                payload: Dict[str, Any] = {"status": job.status}
                if job.status == JobStatus.DONE and job.download_url:
                    payload["download_url"] = job.download_url
                yield f"data: {json.dumps(payload)}\n\n"
                last_status = job.status
                if job.status in {JobStatus.DONE, JobStatus.ERROR}:
                    break

            await asyncio.sleep(1)

    return StreamingResponse(event_generator(job_id), media_type="text/event-stream")

# ---------- Download ----------

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

    filename = f"compressed_video_{job.job_id}.mp4"
    return FileResponse(job.output_path, filename=filename, media_type="video/mp4")

# ---------- Health ----------

@app.get("/healthz")
async def health() -> Dict[str, str]:
    return {"status": "ok"}

if __name__ == "__main__":  # pragma: no cover
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
