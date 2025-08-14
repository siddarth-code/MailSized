"""
MailSized – robust FastAPI app entrypoint.

- Safe static/templates discovery (works locally and on Render)
- Creates FastAPI app BEFORE mounting (fixes NameError)
- Creates static/temp folders if missing (avoids RuntimeError)
- Upload -> Stripe checkout -> webhook -> job -> SSE -> download
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
from pathlib import Path
from typing import Any, Dict, Optional

import requests
import stripe
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ---------- Logging ----------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mailsized")

# ---------- Stripe ----------
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

# ---------- App (create FIRST!) ----------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # lock this down to your domain in prod
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- Paths (robust discovery) ----------
APP_DIR = Path(__file__).resolve().parent
REPO_DIR = APP_DIR.parent  # repo root when structure is repo/app/*

STATIC_CANDIDATES = [
    APP_DIR / "static",                        # app/static   (your current layout)
    REPO_DIR / "static",                       # static at repo root
    Path("/opt/render/project/src/app/static"),
    Path("/opt/render/project/src/static"),
]
TEMPLATES_CANDIDATES = [
    APP_DIR / "templates",                     # app/templates (your current layout)
    REPO_DIR / "templates",                    # templates at repo root
    Path("/opt/render/project/src/app/templates"),
    Path("/opt/render/project/src/templates"),
]

def _pick_dir(candidates: list[Path], create: bool, label: str) -> Path:
    for d in candidates:
        if d.exists() and d.is_dir():
            return d
    chosen = candidates[0]
    if create:
        chosen.mkdir(parents=True, exist_ok=True)
        logger.warning("'%s' not found; created fallback at: %s", label, chosen)
    else:
        logger.warning("'%s' not found; looked in: %s", label, [str(c) for c in candidates])
    return chosen

STATIC_DIR = _pick_dir(STATIC_CANDIDATES, create=True, label="static")
TEMPLATES_DIR = _pick_dir(TEMPLATES_CANDIDATES, create=False, label="templates")

# Mount after app exists
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

# Temp uploads
if "RENDER" in os.environ:
    TEMP_UPLOAD_DIR = Path("/opt/render/project/src/temp_uploads")
else:
    TEMP_UPLOAD_DIR = APP_DIR / "temp_uploads"
TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ---------- Limits / Pricing ----------
MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi"}

PROVIDER_TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}
PROVIDER_PRICING = {
    "gmail": [1.99, 2.99, 4.99],
    "outlook": [2.19, 3.29, 4.99],
    "other": [2.49, 3.99, 5.49],
}

# ---------- Simple model ----------
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

# ---------- Helpers ----------
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

async def probe_duration(file_path: str) -> float:
    """Get duration (s) via ffprobe. Returns 0.0 on failure."""
    ffprobe_bin = str((REPO_DIR / "bin" / "ffprobe") if (REPO_DIR / "bin" / "ffprobe").exists() else "ffprobe")
    try:
        res = subprocess.run(
            [ffprobe_bin, "-v", "error", "-show_entries", "format=duration", "-of",
             "default=noprint_wrappers=1:nokey=1", file_path],
            capture_output=True, text=True, check=True
        )
        return float(res.stdout.strip())
    except Exception as exc:
        logger.warning("ffprobe failed: %s", exc)
        return 0.0

def _tier_for(duration_sec: int, size_bytes: int) -> Dict[str, Any]:
    """≤500MB/≤1GB/≤2GB caps + 5/10/20 min."""
    minutes = duration_sec / 60
    mb_size = size_bytes / (1024 * 1024)
    if minutes <= 5 and mb_size <= 500:
        return {"tier": 1, "price": 1.99, "max_length_min": 5, "max_size_mb": 500}
    if minutes <= 10 and mb_size <= 1024:
        return {"tier": 2, "price": 2.99, "max_length_min": 10, "max_size_mb": 1024}
    if minutes <= 20 and mb_size <= 2048:
        return {"tier": 3, "price": 4.99, "max_length_min": 20, "max_size_mb": 2048}
    raise ValueError("Video exceeds allowed limits for all tiers.")

async def _compress_video(src: str, dst: str, target_mb: int) -> None:
    """
    Placeholder for your real compression.
    If you already integrated the 1‑pass/2‑pass logic, call it here.
    For now, copy (so pipeline stays functional).
    """
    # Example: await run_ffmpeg_two_pass(src, dst, target_mb)  # your real function
    await asyncio.sleep(1)
    shutil.copy(src, dst)

async def _send_email_mailgun_or_smtp(recipient: str, url: str) -> None:
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your compressed video is ready"
    body = f"Your video is ready for the next 30 minutes:\n{url}"

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
                timeout=10,
            )
            r.raise_for_status()
            logger.info("Email sent via Mailgun to %s", recipient)
            return
        except Exception as exc:
            logger.warning("Mailgun failed: %s", exc)

    # Fallback SMTP
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
        logger.info("Email sent via SMTP to %s", recipient)
    except Exception as exc:
        logger.warning("SMTP send failed: %s", exc)

async def _run_job(job: Job) -> None:
    try:
        job.status = JobStatus.PROCESSING
        await asyncio.sleep(0.5)

        job.status = JobStatus.COMPRESSING
        out_name = f"compressed_{job.job_id}.mp4"
        job.output_path = str(TEMP_UPLOAD_DIR / out_name)
        await _compress_video(job.file_path, job.output_path, job.target_size_mb or 25)

        job.status = JobStatus.FINALIZING
        await asyncio.sleep(0.5)

        ttl_min = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
        job.download_expiry = datetime.utcnow() + timedelta(minutes=ttl_min)
        job.status = JobStatus.DONE

        if job.email:
            await _send_email_mailgun_or_smtp(job.email, job.download_url or "")

        asyncio.create_task(_cleanup_job(job.job_id))
    except Exception as exc:
        logger.exception("Job %s error: %s", job.job_id, exc)
        job.status = JobStatus.ERROR

async def _cleanup_job(job_id: str) -> None:
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

# ---------- Routes ----------
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

    duration = await probe_duration(str(temp_path))
    if duration > MAX_DURATION_SEC:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    try:
        pricing = _tier_for(int(duration), total)
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
        "price": pricing["price"],  # Gmail base (UI adjusts by provider)
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
        logger.warning("Stripe webhook signature check failed: %s", exc)
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
            asyncio.create_task(_run_job(job))
            logger.info("Started job %s after Stripe payment", job_id)
        else:
            logger.warning("Webhook for unknown job_id=%s", job_id)

    return {"received": True}

@app.get("/events/{job_id}")
async def events(job_id: str):
    async def gen(jid: str):
        last = None
        # Optional: emit a "percent" field if your compression provides it
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

if __name__ == "__main__":  # pragma: no cover
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
