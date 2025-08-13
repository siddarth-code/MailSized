# app/main.py
from __future__ import annotations

import asyncio
import json
import logging
import math
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

# ---------- Config ----------
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailsized")

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

BASE_DIR = os.path.dirname(__file__)
TEMP_UPLOAD_DIR = "/opt/render/project/src/temp_uploads" if "RENDER" in os.environ else os.path.join(BASE_DIR, "temp_uploads")
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)

# limits/caps
MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60
ALLOWED_EXTS = {".mp4", ".mov", ".mkv", ".avi"}

# Email provider -> attachment target (MB)
PROVIDER_TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}

# Provider pricing by tier index (tier 1..3 -> [0..2])
PROVIDER_PRICING = {
    "gmail":   [1.99, 2.99, 4.99],
    "outlook": [2.19, 3.29, 4.99],
    "other":   [2.49, 3.99, 5.49],
}

# preferred ffmpeg binaries
FFMPEG = os.path.join(os.getcwd(), "bin/ffmpeg")   if os.path.exists(os.path.join(os.getcwd(), "bin/ffmpeg"))   else "ffmpeg"
FFPROBE= os.path.join(os.getcwd(), "bin/ffprobe")  if os.path.exists(os.path.join(os.getcwd(), "bin/ffprobe"))  else "ffprobe"

# ---------- helpers ----------

def adsense_script_tag() -> str:
    enabled = os.getenv("ENABLE_ADSENSE", "false").lower() == "true"
    consent = os.getenv("CONSENT_GIVEN", "false").lower() == "true"
    client  = os.getenv("ADSENSE_CLIENT_ID", "").strip()
    if not (enabled and consent and client):
        return ""
    return (f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={client}" '
            'crossorigin="anonymous"></script>')

def calculate_pricing(duration_sec: int, size_bytes: int) -> Dict[str, Any]:
    """Tier by duration and size caps: ≤500MB / ≤1GB / ≤2GB."""
    minutes = duration_sec / 60
    size_mb = size_bytes / (1024 * 1024)
    if minutes <= 5 and size_mb <= 500:
        return {"tier": 1, "price": 1.99, "max_length_min": 5, "max_size_mb": 500}
    if minutes <= 10 and size_mb <= 1024:
        return {"tier": 2, "price": 2.99, "max_length_min": 10, "max_size_mb": 1024}
    if minutes <= 20 and size_mb <= 2048:
        return {"tier": 3, "price": 4.99, "max_length_min": 20, "max_size_mb": 2048}
    raise ValueError("Video exceeds allowed limits for all tiers.")

async def ffprobe_duration(path: str) -> float:
    try:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nokey=1:noprint_wrappers=1", path],
            capture_output=True, text=True, check=True
        )
        return float(out.stdout.strip())
    except Exception as e:
        log.warning("ffprobe failed: %s", e)
        return 0.0

def compute_target_bitrates(duration_sec: float, target_size_mb: int, audio_kbps: int = 96) -> Dict[str, int]:
    """
    Compute approximate video bitrate (kbps) to hit the given target file size.
    Reserve 5% container overhead and audio_kbps for audio.
    """
    # bytes target -> bits
    bits_total = target_size_mb * 1024 * 1024 * 8
    bits_container = bits_total * 0.05
    bits_for_streams = bits_total - bits_container
    if duration_sec <= 0:
        duration_sec = 1
    total_kbps = (bits_for_streams / duration_sec) / 1000.0
    video_kbps = max(150, int(total_kbps - audio_kbps))  # enforce a floor
    return {"video_kbps": video_kbps, "audio_kbps": audio_kbps}

async def ffmpeg_two_pass(input_path: str, output_path: str, video_kbps: int, audio_kbps: int) -> None:
    """Run x264 two-pass ABR to target a specific size."""
    passlog = os.path.join(TEMP_UPLOAD_DIR, f"ffpass_{uuid.uuid4().hex}")
    # 1st pass
    cmd1 = [
        FFMPEG, "-y", "-i", input_path,
        "-c:v", "libx264", "-preset", "medium", "-b:v", f"{video_kbps}k",
        "-pass", "1", "-passlogfile", passlog,
        "-an", "-f", "mp4", os.devnull
    ]
    # 2nd pass
    cmd2 = [
        FFMPEG, "-y", "-i", input_path,
        "-c:v", "libx264", "-preset", "medium", "-b:v", f"{video_kbps}k",
        "-pass", "2", "-passlogfile", passlog,
        "-c:a", "aac", "-b:a", f"{audio_kbps}k",
        "-movflags", "+faststart",
        output_path
    ]
    try:
        subprocess.run(cmd1, check=True, capture_output=True)
        subprocess.run(cmd2, check=True, capture_output=True)
    finally:
        # cleanup pass files
        for ext in (".log", ".log.mbtree"):
            p = f"{passlog}{ext}"
            if os.path.exists(p): 
                try: os.remove(p)
                except Exception: pass

async def compress_to_target(input_path: str, output_path: str, target_size_mb: int, duration_sec: float) -> None:
    """If source already <= target, fast copy. Else 2-pass ABR to hit target."""
    try:
        src_size_mb = os.path.getsize(input_path) / (1024*1024)
    except Exception:
        src_size_mb = 99999

    if src_size_mb <= target_size_mb * 0.98:
        # already small enough -> quickstream copy (normalize container)
        subprocess.run(
            [FFMPEG, "-y", "-i", input_path, "-c", "copy", "-movflags", "+faststart", output_path],
            check=True, capture_output=True
        )
        return

    rates = compute_target_bitrates(duration_sec, target_size_mb, audio_kbps=96)
    await ffmpeg_two_pass(input_path, output_path, rates["video_kbps"], rates["audio_kbps"])

async def send_email(recipient: str, download_url: str) -> None:
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your compressed video is ready"
    body = f"Your video is ready for the next 30 minutes:\n{download_url}"

    mg_key = os.getenv("MAILGUN_API_KEY")
    mg_dom = os.getenv("MAILGUN_DOMAIN")
    if mg_key and mg_dom and recipient:
        def _send():
            data = {
                "from": sender, "to": [recipient], "subject": subject, "text": body,
                "h:Auto-Submitted":"auto-generated", "h:X-Auto-Response-Suppress":"All", "h:Reply-To":"no-reply@mailsized.com"
            }
            r = requests.post(f"https://api.mailgun.net/v3/{mg_dom}/messages", auth=("api", mg_key), data=data, timeout=10)
            r.raise_for_status()
        try:
            await asyncio.to_thread(_send)
            log.info("Email sent to %s via Mailgun", recipient)
            return
        except Exception as e:
            log.warning("Mailgun failed: %s", e)

    host = os.getenv("EMAIL_SMTP_HOST"); port=os.getenv("EMAIL_SMTP_PORT")
    user = os.getenv("EMAIL_USERNAME");   pwd = os.getenv("EMAIL_PASSWORD")
    if not (host and port and user and pwd and recipient):
        log.info("Email not sent (no Mailgun or SMTP creds).")
        return
    import smtplib
    from email.mime.text import MIMEText
    msg = MIMEText(body, "plain")
    msg["From"]=sender; msg["To"]=recipient; msg["Subject"]=subject
    msg["Auto-Submitted"]="auto-generated"; msg["X-Auto-Response-Suppress"]="All"; msg["Reply-To"]="no-reply@mailsized.com"
    try:
        with smtplib.SMTP(host, int(port)) as s:
            s.starttls(); s.login(user, pwd); s.sendmail(sender, [recipient], msg.as_string())
        log.info("Email sent to %s via SMTP", recipient)
    except Exception as e:
        log.warning("SMTP failed: %s", e)

# ---------- job model ----------

class JobStatus:
    QUEUED="queued"; PROCESSING="processing"; COMPRESSING="compressing"; FINALIZING="finalizing"; DONE="done"; ERROR="error"

class Job:
    def __init__(self, job_id: str, path: str, duration: float, size_bytes: int, pricing: Dict[str,Any]):
        self.job_id = job_id
        self.file_path = path
        self.duration = duration
        self.size_bytes = size_bytes
        self.pricing = pricing

        self.provider: Optional[str] = None
        self.priority: bool = False
        self.transcript: bool = False
        self.email: Optional[str] = None
        self.target_size_mb: Optional[int] = None

        self.status = JobStatus.QUEUED
        self.output_path: Optional[str] = None
        self.download_expiry: Optional[datetime] = None

    @property
    def download_url(self) -> Optional[str]:
        return f"/download/{self.job_id}" if (self.status == JobStatus.DONE and self.output_path) else None

jobs: Dict[str, Job] = {}

# ---------- FastAPI ----------

app = FastAPI()
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request, "adsense_tag": adsense_script_tag(), "adsense_client_id": os.getenv("ADSENSE_CLIENT_ID","")})

@app.get("/terms", response_class=HTMLResponse)
async def terms(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("terms.html", {"request": request})

@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXTS:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    job_id = str(uuid.uuid4())
    temp_path = os.path.join(TEMP_UPLOAD_DIR, f"upload_{job_id}{ext}")
    total = 0
    with open(temp_path, "wb") as out:
        while True:
            chunk = await file.read(1024*1024)
            if not chunk: break
            out.write(chunk); total += len(chunk)
            if total > MAX_SIZE_GB*1024*1024*1024:
                out.close(); os.remove(temp_path)
                raise HTTPException(400, "File exceeds 2GB limit")

    dur = await ffprobe_duration(temp_path)
    if dur > MAX_DURATION_SEC:
        os.remove(temp_path)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    try:
        pricing = calculate_pricing(int(dur), total)
    except ValueError as e:
        os.remove(temp_path); raise HTTPException(400, str(e))

    job = Job(job_id, temp_path, dur, total, pricing)
    jobs[job_id] = job

    return JSONResponse({
        "job_id": job_id, "duration_sec": dur, "size_bytes": total,
        "tier": pricing["tier"], "price": pricing["price"], "max_length_min": pricing["max_length_min"], "max_size_mb": pricing["max_size_mb"]
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
    if not job: raise HTTPException(400, "Invalid job ID")
    if provider not in PROVIDER_TARGETS_MB: raise HTTPException(400, "Unknown email provider")

    job.provider = provider
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = (email or "").strip() or None
    job.target_size_mb = PROVIDER_TARGETS_MB[provider]

    tier = int(job.pricing["tier"])
    base = float(PROVIDER_PRICING[provider][tier-1])
    upsells = (0.75 if job.priority else 0) + (1.50 if job.transcript else 0)
    total = round(base + upsells, 2)
    amount_cents = int(round(total * 100))

    meta = {
        "job_id": job_id, "provider": provider,
        "priority": str(job.priority), "transcript": str(job.transcript),
        "email": job.email or "", "target_size_mb": str(job.target_size_mb),
        "tier": str(tier), "base_price": str(base),
    }

    base_url = os.getenv("PUBLIC_BASE_URL", "").strip() or str(request.base_url).rstrip("/")
    success_url = f"{base_url}/?paid=1&job_id={job_id}"
    cancel_url  = f"{base_url}/?canceled=1&job_id={job_id}"

    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[{
            "price_data": {"currency":"usd", "product_data":{"name": f"MailSized compression (Tier {tier})"}, "unit_amount": amount_cents},
            "quantity": 1
        }],
        success_url=success_url, cancel_url=cancel_url, metadata=meta
    )
    return JSONResponse({"checkout_url": session.url, "session_id": session.id})

@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    if not secret:
        log.error("STRIPE_WEBHOOK_SECRET not set")
        return JSONResponse(status_code=400, content={"detail":"Webhook secret not configured"})
    try:
        event = stripe.Webhook.construct_event(payload, sig, secret)
    except Exception as e:
        log.warning("Stripe signature verification failed: %s", e)
        return JSONResponse(status_code=400, content={"detail":"Bad signature"})

    if event["type"] == "checkout.session.completed":
        data = event["data"]["object"]
        meta = data.get("metadata", {}) or {}
        job_id = meta.get("job_id")
        job = jobs.get(job_id)
        if job:
            # restore and start
            job.provider   = meta.get("provider") or job.provider
            job.priority   = (meta.get("priority") in ("True","true"))
            job.transcript = (meta.get("transcript") in ("True","true"))
            job.email      = (meta.get("email") or "").strip() or job.email
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

async def run_job(job: Job) -> None:
    try:
        job.status = JobStatus.PROCESSING
        await asyncio.sleep(0.5)
        job.status = JobStatus.COMPRESSING

        out_path = os.path.join(TEMP_UPLOAD_DIR, f"compressed_{job.job_id}.mp4")
        job.output_path = out_path

        target_mb = job.target_size_mb or 25
        await compress_to_target(job.file_path, out_path, target_mb, job.duration)

        job.status = JobStatus.FINALIZING
        await asyncio.sleep(0.5)

        job.download_expiry = datetime.utcnow() + timedelta(minutes=int(os.getenv("DOWNLOAD_TTL_MIN","30")))
        job.status = JobStatus.DONE

        if job.email:
            await send_email(job.email, job.download_url or "")

        asyncio.create_task(cleanup_job(job.job_id))
    except Exception as e:
        log.exception("Job %s failed: %s", job.job_id, e)
        job.status = JobStatus.ERROR

async def cleanup_job(job_id: str) -> None:
    job = jobs.get(job_id)
    if not job or not job.download_expiry: return
    delay = (job.download_expiry - datetime.utcnow()).total_seconds()
    if delay > 0: await asyncio.sleep(delay)
    try:
        if job.output_path and os.path.exists(job.output_path): os.remove(job.output_path)
        if os.path.exists(job.file_path): os.remove(job.file_path)
    except Exception as e:
        log.warning("Cleanup failed for %s: %s", job_id, e)
    jobs.pop(job_id, None)

@app.get("/events/{job_id}")
async def events(job_id: str):
    async def gen():
        last = None
        while True:
            job = jobs.get(job_id)
            if not job:
                yield f"data: {json.dumps({'status': JobStatus.ERROR, 'message': 'Job not found'})}\n\n"; break
            if job.status != last:
                payload: Dict[str, Any] = {"status": job.status}
                if job.status == JobStatus.DONE and job.download_url:
                    payload["download_url"] = job.download_url
                yield f"data: {json.dumps(payload)}\n\n"
                last = job.status
                if job.status in {JobStatus.DONE, JobStatus.ERROR}: break
            await asyncio.sleep(1)
    return StreamingResponse(gen(), media_type="text/event-stream")

@app.get("/download/{job_id}")
async def download(job_id: str):
    job = jobs.get(job_id)
    if not job: raise HTTPException(404, "Job not found")
    if job.status != JobStatus.DONE or not job.output_path: raise HTTPException(400, "File not ready")
    if job.download_expiry and datetime.utcnow() > job.download_expiry: raise HTTPException(410, "Download link expired")
    if not os.path.exists(job.output_path): raise HTTPException(404, "File not found")
    return FileResponse(job.output_path, filename=f"compressed_video_{job.job_id}.mp4", media_type="video/mp4")

@app.get("/healthz")
async def health(): return {"status":"ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT","8000")))
