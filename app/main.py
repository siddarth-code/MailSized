"""
MailSized – FastAPI app
- Upload → Stripe → 2‑pass FFmpeg ABR → Download
- Live SSE progress based on FFmpeg -progress out_time_ms
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
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ---------- Logging ----------

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailsized")

# ---------- Paths / FFmpeg ----------

BASE_DIR = os.path.dirname(__file__)
APP_DIR = BASE_DIR                               # app/
STATIC_DIR = os.path.join(APP_DIR, "static")     # app/static
TEMPLATE_DIR = os.path.join(APP_DIR, "templates")  # app/templates

if "RENDER" in os.environ:
    TEMP_DIR = "/opt/render/project/src/temp_uploads"
else:
    TEMP_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "temp_uploads"))

os.makedirs(TEMP_DIR, exist_ok=True)

FFMPEG = os.path.abspath(os.path.join(os.path.dirname(BASE_DIR), "bin", "ffmpeg"))
FFPROBE = os.path.abspath(os.path.join(os.path.dirname(BASE_DIR), "bin", "ffprobe"))
if not (os.path.exists(FFMPEG) and os.path.exists(FFPROBE)):
    # Fallback to PATH (useful locally)
    FFMPEG = "ffmpeg"
    FFPROBE = "ffprobe"

# ---------- Stripe ----------

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")
WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")

# ---------- Limits & Pricing ----------

ALLOWED_EXT = {".mp4", ".mov", ".mkv", ".avi"}
MAX_SIZE_GB = 2
MAX_DURATION_S = 20 * 60

# Provider size targets (MB) for attachment caps
PROVIDER_TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}

# Tiered pricing per provider (tier 1,2,3)
PROVIDER_PRICING = {
    "gmail": [1.99, 2.99, 4.99],
    "outlook": [2.19, 3.29, 4.99],
    "other": [2.49, 3.99, 5.49],
}

# ---------- App & Mounts ----------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"]
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATE_DIR)

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
    PASS1 = "pass1"
    PASS2 = "pass2"
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

        # Set during checkout
        self.provider: Optional[str] = None
        self.priority: bool = False
        self.transcript: bool = False
        self.email: Optional[str] = None
        self.target_size_mb: Optional[int] = None

        self.status: str = JobStatus.QUEUED
        self.progress_pct: int = 0
        self.output_path: Optional[str] = None
        self.download_expiry: Optional[datetime] = None

    @property
    def download_url(self) -> Optional[str]:
        if self.status == JobStatus.DONE and self.output_path:
            return f"/download/{self.job_id}"
        return None

jobs: Dict[str, Job] = {}

# ---------- Helpers ----------

def calculate_pricing(duration_sec: int, file_size_bytes: int) -> Dict[str, Any]:
    minutes = duration_sec / 60
    mb = file_size_bytes / (1024 * 1024)

    if minutes <= 5 and mb <= 500:
        tier, price, max_len, max_mb = 1, 1.99, 5, 500
    elif minutes <= 10 and mb <= 1024:
        tier, price, max_len, max_mb = 2, 2.99, 10, 1024
    elif minutes <= 20 and mb <= 2048:
        tier, price, max_len, max_mb = 3, 4.99, 20, 2048
    else:
        raise ValueError("Video exceeds allowed limits.")

    return {
        "tier": tier,
        "price": round(price, 2),  # base Gmail price; UI swaps per provider
        "max_length_min": max_len,
        "max_size_mb": max_mb,
    }

async def probe_duration(path: str) -> float:
    try:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, check=True
        )
        return float(out.stdout.strip())
    except Exception as e:
        log.warning("ffprobe failed: %s", e)
        return 0.0

def human_pct(p: float) -> int:
    try:
        return max(0, min(100, int(round(p))))
    except Exception:
        return 0

async def send_email(recipient: str, download_url: str) -> None:
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your compressed video is ready"
    ttl_min = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
    body = f"Your video is ready for {ttl_min} minutes:\n{download_url}"

    mg_key = os.getenv("MAILGUN_API_KEY")
    mg_domain = os.getenv("MAILGUN_DOMAIN")

    if mg_key and mg_domain and recipient:
        try:
            r = requests.post(
                f"https://api.mailgun.net/v3/{mg_domain}/messages",
                auth=("api", mg_key),
                data={
                    "from": sender, "to": [recipient], "subject": subject, "text": body,
                    "h:Auto-Submitted": "auto-generated",
                    "h:X-Auto-Response-Suppress": "All",
                    "h:Reply-To": "no-reply@mailsized.com",
                }, timeout=10
            )
            r.raise_for_status()
            log.info("Email sent via Mailgun to %s", recipient)
            return
        except Exception as e:
            log.warning("Mailgun failed: %s", e)

    # SMTP fallback
    host = os.getenv("EMAIL_SMTP_HOST")
    port = os.getenv("EMAIL_SMTP_PORT")
    user = os.getenv("EMAIL_USERNAME")
    pwd = os.getenv("EMAIL_PASSWORD")

    if not (host and port and user and pwd and recipient):
        log.info("Email not sent: no Mailgun or SMTP configured.")
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
            s.login(user, pwd)
            s.send_message(msg)
        log.info("Email sent to %s via SMTP", recipient)
    except Exception as e:
        log.warning("SMTP send failed: %s", e)

async def cleanup_job(job: Job) -> None:
    # wait until expiry, then delete files
    if not job.download_expiry:
        return
    delay = (job.download_expiry - datetime.utcnow()).total_seconds()
    if delay > 0:
        await asyncio.sleep(delay)
    try:
        if job.output_path and os.path.exists(job.output_path):
            os.remove(job.output_path)
        if os.path.exists(job.file_path):
            os.remove(job.file_path)
    except Exception as e:
        log.warning("Cleanup failed for %s: %s", job.job_id, e)
    jobs.pop(job.job_id, None)
    log.info("Cleaned job %s", job.job_id)

# ---------- Compression (2‑pass with live progress) ----------

def compute_target_bitrates(target_mb: int, duration_s: float) -> tuple[int, int]:
    """
    Compute video and audio bitrates (bps) to land near target size.
    Reserve ~80 kbps for audio; rest to video.
    """
    if duration_s <= 0:
        # conservative defaults
        return 600_000, 80_000

    target_bits = target_mb * 1024 * 1024 * 8
    audio_bps = 80_000
    video_bps = max(200_000, int((target_bits / duration_s) - audio_bps))
    return video_bps, audio_bps

async def run_ffmpeg_2pass_with_progress(job: Job) -> None:
    """
    2‑pass ABR and stream progress. Map:
      - PASS1: raises progress to ~15%
      - PASS2: 15%→99% using out_time_ms / duration
    """
    job.status = JobStatus.PROCESSING
    job.progress_pct = 1

    # Paths
    ext = os.path.splitext(job.file_path)[1].lower() or ".mp4"
    out_path = os.path.join(TEMP_DIR, f"compressed_{job.job_id}.mp4")
    passlog = os.path.join(TEMP_DIR, f"fflog_{job.job_id}")
    job.output_path = out_path

    # Bitrates
    v_bps, a_bps = compute_target_bitrates(job.target_size_mb or 25, job.duration)
    v_k = max(200, v_bps // 1000)
    a_k = max(64, a_bps // 1000)
    log.info("2-pass target ~%d MB: v=%dkbps a=%dkbps", job.target_size_mb or 25, v_k, a_k)

    # PASS 1
    job.status = JobStatus.PASS1
    job.progress_pct = 5
    cmd1 = [
        FFMPEG, "-y",
        "-i", job.file_path,
        "-c:v", "libx264", "-preset", "medium",
        "-b:v", f"{v_k}k",
        "-pass", "1", "-passlogfile", passlog,
        "-an",
        "-movflags", "+faststart",
        "-f", "mp4",
        os.devnull,
    ]
    proc1 = await asyncio.create_subprocess_exec(*cmd1,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE)

    # consume stderr to avoid pipe fill; we don't parse it here
    await proc1.communicate()
    if proc1.returncode != 0:
        job.status = JobStatus.ERROR
        raise RuntimeError("FFmpeg pass1 failed")

    job.progress_pct = 15  # bump after pass1

    # PASS 2 with live progress
    job.status = JobStatus.PASS2
    cmd2 = [
        FFMPEG, "-y",
        "-i", job.file_path,
        "-c:v", "libx264", "-preset", "medium",
        "-b:v", f"{v_k}k",
        "-maxrate", f"{int(v_k*1.25)}k",
        "-bufsize", f"{int(v_k*2)}k",
        "-pass", "2", "-passlogfile", passlog,
        "-c:a", "aac", "-b:a", f"{a_k}k",
        "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats", "-loglevel", "error",
        out_path,
    ]
    proc2 = await asyncio.create_subprocess_exec(*cmd2,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)

    duration_ms = max(1, int(job.duration * 1000))
    # Read progress stream line by line
    while True:
        line = await proc2.stdout.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="ignore").strip()

        # FFmpeg -progress lines include keys like out_time_ms=1234567
        if text.startswith("out_time_ms="):
            try:
                t_ms = int(text.split("=", 1)[1])
                # map 15%..99%
                frac = min(1.0, max(0.0, t_ms / duration_ms))
                job.progress_pct = human_pct(15 + frac * 84)  # 15→99
            except Exception:
                pass
        elif text.startswith("progress=") and text.endswith("end"):
            job.progress_pct = 99

    rc = await proc2.wait()
    # clean passlog files
    for suf in (".log", "-0.log", ".log.mbtree"):
        p = f"{passlog}{suf}"
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass

    if rc != 0 or not os.path.exists(out_path):
        job.status = JobStatus.ERROR
        raise RuntimeError("FFmpeg pass2 failed")

async def run_job(job: Job) -> None:
    try:
        # compress
        await run_ffmpeg_2pass_with_progress(job)

        # finalize
        job.status = JobStatus.FINALIZING
        job.progress_pct = 100
        ttl_min = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
        job.download_expiry = datetime.utcnow() + timedelta(minutes=ttl_min)
        job.status = JobStatus.DONE

        if job.email:
            await send_email(job.email, job.download_url or "")

        asyncio.create_task(cleanup_job(job))
    except Exception as e:
        log.exception("Job %s failed: %s", job.job_id, e)
        job.status = JobStatus.ERROR

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
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    job_id = str(uuid.uuid4())
    tmp_path = os.path.join(TEMP_DIR, f"upload_{job_id}{ext}")

    max_bytes = MAX_SIZE_GB * 1024 * 1024 * 1024
    size = 0
    with open(tmp_path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            size += len(chunk)
            if size > max_bytes:
                f.close()
                os.remove(tmp_path)
                raise HTTPException(400, "File exceeds 2GB limit")

    duration = await probe_duration(tmp_path)
    if duration <= 0:
        # allow short unknown; we still try
        pass
    if duration > MAX_DURATION_S:
        os.remove(tmp_path)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    pricing = calculate_pricing(int(duration), size)
    job = Job(job_id, tmp_path, duration, size, pricing)
    jobs[job_id] = job

    return JSONResponse({
        "job_id": job_id,
        "duration_sec": duration,
        "size_bytes": size,
        "tier": pricing["tier"],
        "price": pricing["price"],  # UI swaps provider
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
        raise HTTPException(400, "Invalid job")

    if provider not in PROVIDER_TARGETS_MB:
        raise HTTPException(400, "Unknown provider")

    job.provider = provider
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = (email or "").strip() or None
    job.target_size_mb = PROVIDER_TARGETS_MB[provider]

    tier = int(job.pricing["tier"])
    base = float(PROVIDER_PRICING[provider][tier - 1])
    upsells = (0.75 if job.priority else 0) + (1.50 if job.transcript else 0)
    total = round(base + upsells, 2)

    base_url = os.getenv("PUBLIC_BASE_URL", "").strip() or str(request.base_url).rstrip("/")
    success_url = f"{base_url}/?paid=1&job_id={job_id}"
    cancel_url = f"{base_url}/?canceled=1&job_id={job_id}"

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
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={
            "job_id": job_id,
            "provider": provider,
            "priority": str(job.priority),
            "transcript": str(job.transcript),
            "email": job.email or "",
            "target_size_mb": str(job.target_size_mb),
            "tier": str(tier),
            "base_price": str(base),
        },
    )
    return JSONResponse({"checkout_url": session.url, "session_id": session.id})

@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    if not WEBHOOK_SECRET:
        log.error("STRIPE_WEBHOOK_SECRET not set")
        return JSONResponse(status_code=400, content={"detail": "Webhook secret not configured"})
    payload = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, WEBHOOK_SECRET)
    except Exception as e:
        log.warning("Stripe signature check failed: %s", e)
        return JSONResponse(status_code=400, content={"detail": "Bad signature"})

    if event["type"] == "checkout.session.completed":
        data = event["data"]["object"]
        meta = data.get("metadata", {}) or {}
        job_id = meta.get("job_id")
        job = jobs.get(job_id)
        if job:
            # ensure selections present
            job.provider = meta.get("provider") or job.provider
            job.priority = (meta.get("priority") in ("True", "true", "1"))
            job.transcript = (meta.get("transcript") in ("True", "true", "1"))
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
            log.warning("Webhook received for unknown job_id=%s", job_id)
    return {"received": True}

@app.get("/events/{job_id}")
async def events(job_id: str):
    async def gen():
        last = {"status": None, "pct": -1, "url": None}
        while True:
            job = jobs.get(job_id)
            if not job:
                yield f"data: {json.dumps({'status': JobStatus.ERROR, 'pct': 0, 'message':'Job not found'})}\n\n"
                break

            payload: Dict[str, Any] = {"status": job.status, "pct": job.progress_pct}
            if job.status == JobStatus.DONE and job.download_url:
                payload["download_url"] = job.download_url

            if payload["status"] != last["status"] or payload["pct"] != last["pct"] or payload.get("download_url") != last["url"]:
                yield f"data: {json.dumps(payload)}\n\n"
                last = {"status": payload["status"], "pct": payload["pct"], "url": payload.get("download_url")}

                if job.status in (JobStatus.DONE, JobStatus.ERROR):
                    break

            await asyncio.sleep(0.7)

    return StreamingResponse(gen(), media_type="text/event-stream")

@app.get("/download/{job_id}")
async def download(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != JobStatus.DONE or not job.output_path:
        raise HTTPException(400, "File not ready")
    if job.download_expiry and datetime.utcnow() > job.download_expiry:
        raise HTTPException(410, "Link expired")
    if not os.path.exists(job.output_path):
        raise HTTPException(404, "File missing")

    fname = f"compressed_{job.job_id}.mp4"
    return FileResponse(job.output_path, filename=fname, media_type="video/mp4")

@app.get("/healthz")
async def health():
    return {"ok": True}

if __name__ == "__main__":  # pragma: no cover
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
