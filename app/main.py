"""ASGI entry point for the MailSized service.

This module exposes a FastAPI application named ``app``.  It implements the
full upload→payment→compression→download workflow with tiered pricing,
upload validation, Server‑Sent Events for live status updates and email
notifications.  See the repository README for an overview of the project.
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
from typing import Dict, Any

import requests
import stripe
from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# Stripe key
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Determine working directories
BASE_DIR = os.path.dirname(__file__)
if "RENDER" in os.environ:
    TEMP_UPLOAD_DIR = "/opt/render/project/src/temp_uploads"
else:
    TEMP_UPLOAD_DIR = os.path.join(BASE_DIR, "temp_uploads")
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)

# Global limits
MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi"}

# Provider attachment limits (MB)
PROVIDER_TARGETS_MB = {
    "gmail": 25,
    "outlook": 20,
    "other": 15,
}

# Provider-specific base prices by tier index (1-based tier -> list index)
PROVIDER_PRICING = {
    "gmail":   [1.99, 2.99, 4.49],
    "outlook": [2.19, 3.29, 4.99],
    "other":   [2.49, 3.99, 5.49],
}


def calculate_pricing(duration_sec: int, file_size_bytes: int) -> Dict[str, Any]:
    """Return the pricing tier and base price for a given video.

    The smaller of the video duration (in minutes) and the size (in MB) is
    compared against the defined tiers.  Values beyond Tier 3 result in
    ``ValueError``.
    """
    minutes = duration_sec / 60
    mb_size = file_size_bytes / (1024 * 1024)
    if minutes <= 5 and mb_size <= 100:
        tier, price, max_len, max_mb = 1, 1.99, 5, 100
    elif minutes <= 10 and mb_size <= 200:
        tier, price, max_len, max_mb = 2, 2.99, 10, 200
    elif minutes <= 20 and mb_size <= 400:
        tier, price, max_len, max_mb = 3, 4.99, 20, 400
    else:
        raise ValueError("Video exceeds allowed limits for all tiers.")
    return {
        "tier": tier,
        "price": round(price, 2),
        "max_length_min": max_len,
        "max_size_mb": max_mb,
    }


def adsense_script_tag() -> str:
    """Return a script tag to load Google AdSense when enabled and consented."""
    enabled = os.getenv("ENABLE_ADSENSE", "false").lower() == "true"
    consent = os.getenv("CONSENT_GIVEN", "false").lower() == "true"
    client = os.getenv("ADSENSE_CLIENT_ID", "").strip()
    if not (enabled and consent and client):
        return ""
    return (
        f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={client}" '
        'crossorigin="anonymous"></script>'
    )


# Job state enumeration
class JobStatus:
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPRESSING = "compressing"
    FINALIZING = "finalizing"
    DONE = "done"
    ERROR = "error"


class Job:
    """Represents a video compression job."""

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


# In‑memory job registry
jobs: Dict[str, Job] = {}


async def probe_duration(file_path: str) -> float:
    """Extract duration using ffprobe.  Returns 0 on failure."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            capture_output=True,
            text=True,
            check=True,
        )
        return float(result.stdout.strip())
    except Exception as exc:  # noqa: broad-except
        logger.warning("ffprobe failed to extract duration: %s", exc)
        return 0.0


async def compress_video(file_path: str, output_path: str, target_size_mb: int) -> None:
    """Compress the video.  Placeholder copies the file and simulates delay."""
    api_key = os.getenv("CLOUDCONVERT_API_KEY")
    if api_key:
        # Placeholder for CloudConvert integration
        logger.info("CLOUDCONVERT_API_KEY provided; external API integration would occur here")
    await asyncio.sleep(2)
    shutil.copy(file_path, output_path)


async def send_email(recipient: str, download_url: str) -> None:
    """Send the download link via Mailgun if configured, otherwise SMTP."""
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your compressed video is ready"
    body = (
        f"Your video has been compressed and is ready for download for the next 30 minutes:\n"
        f"{download_url}"
    )

    # Attempt Mailgun integration
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
            response = requests.post(
                f"https://api.mailgun.net/v3/{mg_domain}/messages",
                auth=("api", mg_api_key),
                data=data,
                timeout=10,
            )
            response.raise_for_status()
        try:
            await asyncio.to_thread(_send_mailgun)
            logger.info("Notification email sent to %s via Mailgun", recipient)
            return
        except Exception as exc:  # noqa: broad-except
            logger.warning("Failed to send email via Mailgun: %s", exc)
            # Fall through to SMTP fallback

    # Fallback to SMTP
    host = os.getenv("EMAIL_SMTP_HOST")
    port = os.getenv("EMAIL_SMTP_PORT")
    username = os.getenv("EMAIL_USERNAME")
    password = os.getenv("EMAIL_PASSWORD")
    if not (host and port and username and password and recipient):
        logger.info("Email not sent – no Mailgun credentials and SMTP credentials missing or recipient missing")
        return
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    message = MIMEMultipart()
    message["From"] = sender
    message["To"] = recipient
    message["Subject"] = subject
    message["Auto-Submitted"] = "auto-generated"
    message["X-Auto-Response-Suppress"] = "All"
    message["Reply-To"] = "no-reply@mailsized.com"
    message.attach(MIMEText(body, "plain"))
    try:
        with smtplib.SMTP(host, int(port)) as server:
            server.starttls()
            server.login(username, password)
            server.send_message(message)
        logger.info("Notification email sent to %s via SMTP", recipient)
    except Exception as exc:  # noqa: broad-except
        logger.warning("Failed to send email via SMTP: %s", exc)


async def run_job(job: Job) -> None:
    """Execute a compression job asynchronously."""
    try:
        job.status = JobStatus.PROCESSING
        await asyncio.sleep(1)
        job.status = JobStatus.COMPRESSING
        output_filename = f"compressed_{job.job_id}.mp4"
        output_path = os.path.join(TEMP_UPLOAD_DIR, output_filename)
        job.output_path = output_path
        await compress_video(job.file_path, output_path, job.target_size_mb)
        job.status = JobStatus.FINALIZING
        await asyncio.sleep(1)
        ttl_min = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
        job.download_expiry = datetime.utcnow() + timedelta(minutes=ttl_min)
        job.status = JobStatus.DONE
        if job.email:
            await send_email(job.email, job.download_url)
        asyncio.create_task(cleanup_job(job.job_id))
    except Exception as exc:  # noqa: broad-except
        logger.exception("Error during job execution: %s", exc)
        job.status = JobStatus.ERROR


async def cleanup_job(job_id: str) -> None:
    """Remove job artifacts after expiry."""
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
    except Exception as exc:  # noqa: broad-except
        logger.warning("Failed to remove job files: %s", exc)
    jobs.pop(job_id, None)
    logger.info("Cleaned up job %s", job_id)


# Create the FastAPI application
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount(
    "/static",
    StaticFiles(directory=os.path.join(BASE_DIR, "static")),
    name="static",
)
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "adsense_tag": adsense_script_tag(),
            "adsense_client_id": os.getenv("ADSENSE_CLIENT_ID", ""),
        },
    )


@app.get("/terms", response_class=HTMLResponse)
async def terms(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("terms.html", {"request": request})


@app.post("/upload")
async def upload_video(file: UploadFile = File(...)) -> JSONResponse:
    # Validate file type
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
        raise HTTPException(400, str(exc))
    job = Job(job_id, temp_path, duration_sec, total_bytes, pricing)
    jobs[job_id] = job
    return JSONResponse(
        {
            "job_id": job_id,
            "duration_sec": duration_sec,
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
    email: str | None = Form(None),
) -> JSONResponse:
    # Look up job
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(400, "Invalid job ID")

    # Validate provider
    if provider not in PROVIDER_TARGETS_MB:
        raise HTTPException(400, "Unknown email provider")

    # Store selections on the job so metadata is consistent if the user navigates away
    job.provider = provider
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = email.strip() if email else None
    job.target_size_mb = PROVIDER_TARGETS_MB[provider]

    # --- Provider-based base price by tier ---
    tier = job.pricing["tier"]  # 1, 2, or 3
    provider_prices = PROVIDER_PRICING.get(provider)
    if not provider_prices:
        raise HTTPException(400, "Unknown email provider")
    try:
        base = float(provider_prices[tier - 1])
    except Exception:
        raise HTTPException(400, "Invalid tier for provider pricing")

    # Extras
    upsell_total = (0.75 if job.priority else 0) + (1.50 if job.transcript else 0)
    total = round(base + upsell_total, 2)

    # ---- Stripe Checkout (pay first) ----
    amount_cents = int(round(total * 100))
    metadata = {
        "job_id": job_id,
        "provider": provider,
        "priority": str(job.priority),
        "transcript": str(job.transcript),
        "email": job.email or "",
        "target_size_mb": str(job.target_size_mb),
        "tier": str(job.pricing["tier"]),
        "base_price": str(base),
    }

    base_url = os.getenv("PUBLIC_BASE_URL", "").strip() or str(request.base_url).rstrip("/")
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

    # Do NOT start the job here—wait for webhook
    return JSONResponse({"checkout_url": session.url, "session_id": session.id})


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("Stripe-Signature")
    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
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
            # Rehydrate selections (in case user navigated away)
            job.provider = meta.get("provider") or job.provider
            job.priority = (meta.get("priority") == "True")
            job.transcript = (meta.get("transcript") == "True")
            email = (meta.get("email") or "").strip()
            job.email = email or job.email
            tgt = meta.get("target_size_mb")
            if tgt:
                try:
                    job.target_size_mb = int(tgt)
                except ValueError:
                    pass

            # Start the job now (AFTER payment)
            job.status = JobStatus.QUEUED
            asyncio.create_task(run_job(job))
            logger.info("Started job %s after Stripe payment", job_id)

    return {"received": True}


@app.get("/events/{job_id}")
async def job_events(job_id: str):
    async def event_generator(job_id: str):
        last_status = None
        while True:
            job = jobs.get(job_id)
            if not job:
                yield f"data: {json.dumps({'status': JobStatus.ERROR, 'message': 'Job not found'})}\n\n"
                break
            if job.status != last_status:
                payload = {"status": job.status}
                if job.status == JobStatus.DONE and job.download_url:
                    payload["download_url"] = job.download_url
                yield f"data: {json.dumps(payload)}\n\n"
                last_status = job.status
                if job.status in {JobStatus.DONE, JobStatus.ERROR}:
                    break
            await asyncio.sleep(1)

    return StreamingResponse(event_generator(job_id), media_type="text/event-stream")


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


@app.get("/healthz")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":  # pragma: no cover
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
