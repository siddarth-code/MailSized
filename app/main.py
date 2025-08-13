"""
MailSized – FastAPI service
Upload → Stripe pay → 2‑pass FFmpeg compress → Download (+ Mailgun/SMTP email)
SSE with auto‑reconnect + REST polling fallback.
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

# ────────────── Config ──────────────

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailsized")

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "").strip()

BASE_DIR = os.path.dirname(__file__)
ROOT_DIR = os.path.abspath(os.path.join(BASE_DIR, ".."))

# temp dir (Render friendly)
TEMP_UPLOAD_DIR = "/opt/render/project/src/temp_uploads" if os.getenv("RENDER") else os.path.join(ROOT_DIR, "temp_uploads")
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)

# Add ./bin (static ffmpeg) to PATH at runtime as a safety net
BIN_DIR = os.path.join(ROOT_DIR, "bin")
if os.path.isdir(BIN_DIR) and BIN_DIR not in os.getenv("PATH", ""):
    os.environ["PATH"] = f"{os.environ['PATH']}:{BIN_DIR}"

FFMPEG = os.getenv("FFMPEG_BIN", "ffmpeg")
FFPROBE = os.getenv("FFPROBE_BIN", "ffprobe")

# global limits
MAX_DURATION_SEC = 20 * 60  # 20 min
MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB
ALLOWED_EXT = {".mp4", ".mov", ".mkv", ".avi"}

# attachment targets (MB)
TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}

# provider pricing by tier (≤5 / ≤10 / ≤20 min and ≤500MB / ≤1GB / ≤2GB)
PROVIDER_PRICING = {
    "gmail": [1.99, 2.99, 4.99],
    "outlook": [2.19, 3.29, 4.99],
    "other": [2.49, 3.99, 5.49],
}

UPSells = {"priority": 0.75, "transcript": 1.50}


def tier_for(duration_sec: int, size_bytes: int) -> Dict[str, Any]:
    """Return plan tier (1..3) and caps."""
    mins = duration_sec / 60
    mb = size_bytes / (1024 * 1024)

    if mins <= 5 and mb <= 500:
        return {"tier": 1, "max_len": 5, "max_mb": 500, "base_gmail": 1.99}
    if mins <= 10 and mb <= 1024:
        return {"tier": 2, "max_len": 10, "max_mb": 1024, "base_gmail": 2.99}
    if mins <= 20 and mb <= 2048:
        return {"tier": 3, "max_len": 20, "max_mb": 2048, "base_gmail": 4.99}
    raise ValueError("Video exceeds allowed limits (≤20 min, ≤2 GB).")


def adsense_tag() -> str:
    ok = os.getenv("ENABLE_ADSENSE", "false").lower() == "true"
    consent = os.getenv("CONSENT_GIVEN", "false").lower() == "true"
    client = os.getenv("ADSENSE_CLIENT_ID", "")
    if not (ok and consent and client):
        return ""
    return (
        f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={client}" '
        'crossorigin="anonymous"></script>'
    )


# ────────────── Models ──────────────

class JobStatus:
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPRESSING = "compressing"
    FINALIZING = "finalizing"
    DONE = "done"
    ERROR = "error"


class Job:
    def __init__(self, job_id: str, src: str, duration: float, size_bytes: int, tier_info: Dict[str, Any]):
        self.id = job_id
        self.src = src
        self.duration = duration
        self.size_bytes = size_bytes
        self.tier_info = tier_info

        self.provider: Optional[str] = None
        self.priority: bool = False
        self.transcript: bool = False
        self.email: Optional[str] = None
        self.target_mb: Optional[int] = None

        self.status: str = JobStatus.QUEUED
        self.progress: int = 2  # UI starts at 2%
        self.out_path: Optional[str] = None
        self.expires_at: Optional[datetime] = None

    @property
    def download_url(self) -> Optional[str]:
        if self.status == JobStatus.DONE and self.out_path:
            return f"/download/{self.id}"
        return None


JOBS: Dict[str, Job] = {}


# ────────────── Helpers ──────────────

async def ffprobe_duration(path: str) -> float:
    try:
        p = await asyncio.create_subprocess_exec(
            FFPROBE, "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await p.communicate()
        return float(out.decode().strip())
    except Exception:  # noqa: BLE001
        return 0.0


def calc_two_pass_bitrates(target_mb: int, duration_sec: float) -> tuple[int, int]:
    """
    Compute approximate video/audio bitrates to land near target size.
    Reserve ~6% mux/overhead and ~80 kbps audio as a floor.
    """
    if duration_sec <= 0:
        duration_sec = 1
    total_bits = target_mb * 1024 * 1024 * 8
    overhead = int(total_bits * 0.06)
    budget = max(total_bits - overhead, 128_000)
    a_k = 80_000
    v_k = max(int(budget / duration_sec) - a_k, 120_000)
    return v_k, a_k


async def run_ffmpeg_two_pass(src: str, dst: str, target_mb: int, job: Job) -> None:
    v_kbps, a_bps = calc_two_pass_bitrates(target_mb, job.duration)
    log.info("2-pass target ~%d MB: v=%dkbps a=%dkbps", target_mb, v_kbps // 1000, a_bps // 1000)
    passlog = os.path.join(TEMP_UPLOAD_DIR, f"ffpass_{job.id}")

    # pass 1
    job.status = JobStatus.COMPRESSING
    job.progress = max(job.progress, 10)

    p1 = await asyncio.create_subprocess_exec(
        FFMPEG, "-y", "-i", src,
        "-c:v", "libx264", "-b:v", str(v_kbps),
        "-pass", "1", "-passlogfile", passlog,
        "-an", "-f", "mp4", "/dev/null",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    # opportunistic progress bumps (keeps UI moving even without fine-grain parsing)
    while p1.returncode is None:
        await asyncio.sleep(1)
        job.progress = min(job.progress + 2, 40)
        p1.poll()
    await p1.wait()

    # pass 2
    job.progress = max(job.progress, 45)
    dst_tmp = dst + ".tmp.mp4"
    p2 = await asyncio.create_subprocess_exec(
        FFMPEG, "-y", "-i", src,
        "-c:v", "libx264", "-b:v", str(v_kbps),
        "-pass", "2", "-passlogfile", passlog,
        "-c:a", "aac", "-b:a", str(a_bps),
        dst_tmp,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    while p2.returncode is None:
        await asyncio.sleep(1)
        job.progress = min(job.progress + 3, 95)
        p2.poll()
    await p2.wait()

    # cleanup pass logs
    for ext in (".log", ".log.mbtree"):
        try:
            os.remove(passlog + ext)
        except FileNotFoundError:
            pass

    # finalize
    job.status = JobStatus.FINALIZING
    job.progress = max(job.progress, 97)
    shutil.move(dst_tmp, dst)


async def send_email(recipient: str, download_url: str) -> None:
    if not recipient:
        return
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")

    subject = "Your compressed video is ready"
    body = f"Your video is ready for the next 30 minutes:\n{download_url}"

    mg_key = os.getenv("MAILGUN_API_KEY")
    mg_domain = os.getenv("MAILGUN_DOMAIN")

    if mg_key and mg_domain:
        try:
            r = requests.post(
                f"https://api.mailgun.net/v3/{mg_domain}/messages",
                auth=("api", mg_key),
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
            log.info("Email sent via Mailgun to %s", recipient)
            return
        except Exception as e:  # noqa: BLE001
            log.warning("Mailgun send failed: %s", e)

    # Fallback SMTP
    host = os.getenv("EMAIL_SMTP_HOST")
    port = os.getenv("EMAIL_SMTP_PORT")
    user = os.getenv("EMAIL_USERNAME")
    pwd = os.getenv("EMAIL_PASSWORD")
    if not (host and port and user and pwd):
        log.info("Skipping SMTP: missing credentials")
        return

    import smtplib
    from email.mime.text import MIMEText

    msg = MIMEText(body, "plain")
    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = subject
    msg["Auto-Submitted"] = "auto-generated"
    msg["X-Auto-Response-Suppress"] = "All"
    msg["Reply-To"] = "no-reply@mailsized.com"

    try:
        with smtplib.SMTP(host, int(port)) as s:
            s.ehlo()
            s.starttls()
            s.login(user, pwd)
            s.sendmail(sender, [recipient], msg.as_string())
        log.info("Email sent to %s via SMTP", recipient)
    except Exception as e:  # noqa: BLE001
        log.warning("SMTP send failed: %s", e)


async def run_job(job: Job) -> None:
    try:
        job.status = JobStatus.PROCESSING
        job.progress = 5

        # build output path
        out_name = f"compressed_{job.id}.mp4"
        out_path = os.path.join(TEMP_UPLOAD_DIR, out_name)
        job.out_path = out_path

        # compress
        await run_ffmpeg_two_pass(job.src, out_path, job.target_mb or 25, job)

        # mark complete
        ttl = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
        job.expires_at = datetime.utcnow() + timedelta(minutes=ttl)
        job.status = JobStatus.DONE
        job.progress = 100

        if job.email:
            await send_email(job.email, job.download_url or "")
        asyncio.create_task(clean_after(job.id))
    except Exception as e:  # noqa: BLE001
        log.exception("Job failed %s: %s", job.id, e)
        job.status = JobStatus.ERROR
        job.progress = 100


async def clean_after(job_id: str) -> None:
    j = JOBS.get(job_id)
    if not j or not j.expires_at:
        return
    wait = (j.expires_at - datetime.utcnow()).total_seconds()
    if wait > 0:
        await asyncio.sleep(wait)
    try:
        if j.out_path and os.path.exists(j.out_path):
            os.remove(j.out_path)
        if j.src and os.path.exists(j.src):
            os.remove(j.src)
    finally:
        JOBS.pop(job_id, None)
        log.info("Cleaned job %s", job_id)


# ────────────── App / Routes ──────────────

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=os.path.join(ROOT_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(ROOT_DIR, "templates"))


@app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "adsense_tag": adsense_tag(), "adsense_client_id": os.getenv("ADSENSE_CLIENT_ID", "")},
    )


@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    name = (file.filename or "").lower()
    ext = os.path.splitext(name)[1]
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, "Unsupported file type")

    job_id = str(uuid.uuid4())
    dst = os.path.join(TEMP_UPLOAD_DIR, f"upload_{job_id}{ext}")

    size = 0
    with open(dst, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            size += len(chunk)
            if size > MAX_SIZE_BYTES:
                out.close()
                os.remove(dst)
                raise HTTPException(400, "File exceeds 2GB")

    duration = await ffprobe_duration(dst)
    if duration > MAX_DURATION_SEC:
        os.remove(dst)
        raise HTTPException(400, "Video exceeds 20 minutes")

    tinfo = tier_for(int(duration), size)
    job = Job(job_id, dst, duration, size, tinfo)
    JOBS[job_id] = job

    return JSONResponse(
        {
            "job_id": job_id,
            "duration_sec": duration,
            "size_bytes": size,
            "tier": tinfo["tier"],
            "price": tinfo["base_gmail"],  # UI will swap per provider selection
            "max_length_min": tinfo["max_len"],
            "max_size_mb": tinfo["max_mb"],
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
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(400, "Invalid job")

    if provider not in TARGETS_MB:
        raise HTTPException(400, "Unknown provider")

    job.provider = provider
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = (email or "").strip() or None
    job.target_mb = TARGETS_MB[provider]

    tier = job.tier_info["tier"]
    base = PROVIDER_PRICING[provider][tier - 1]
    upsells = (UPSells["priority"] if job.priority else 0) + (UPSells["transcript"] if job.transcript else 0)
    total = round(base + upsells, 2)

    base_url = (os.getenv("PUBLIC_BASE_URL") or str(request.base_url).rstrip("/")).strip()
    success_url = f"{base_url}/?paid=1&job_id={job_id}"
    cancel_url = f"{base_url}/?canceled=1&job_id={job_id}"

    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[
            {
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": f"MailSized compression (Tier {tier})"},
                    "unit_amount": int(round(total * 100)),
                },
                "quantity": 1,
            }
        ],
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={
                "job_id": job_id,
                "provider": provider,
                "priority": str(job.priority),
                "transcript": str(job.transcript),
                "email": job.email or "",
                "target_size_mb": str(job.target_mb),
                "tier": str(tier),
                "base_price": str(base),
        },
    )
    return JSONResponse({"checkout_url": session.url, "session_id": session.id})


@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    wh_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    if not wh_secret:
        return JSONResponse({"detail": "Webhook secret not configured"}, status_code=400)

    try:
        evt = stripe.Webhook.construct_event(payload, sig, wh_secret)
    except Exception as e:  # noqa: BLE001
        log.warning("Stripe signature failed: %s", e)
        return JSONResponse({"detail": "Bad signature"}, status_code=400)

    if evt["type"] == "checkout.session.completed":
        meta = (evt["data"]["object"] or {}).get("metadata", {}) or {}
        job_id = meta.get("job_id")
        job = JOBS.get(job_id)
        if job:
            # restore selections (defensive)
            job.provider = meta.get("provider") or job.provider
            job.priority = (meta.get("priority") in {"True", "true"})
            job.transcript = (meta.get("transcript") in {"True", "true"})
            email = (meta.get("email") or "").strip()
            job.email = email or job.email
            try:
                job.target_mb = int(meta.get("target_size_mb") or job.target_mb or 25)
            except Exception:
                pass

            job.status = JobStatus.QUEUED
            asyncio.create_task(run_job(job))
            log.info("Started job %s after Stripe payment", job_id)

    return {"received": True}


# Live events (SSE)
@app.get("/events/{job_id}")
async def events(job_id: str):
    async def gen(jid: str):
        last = None
        while True:
            job = JOBS.get(jid)
            if not job:
                yield f"data: {json.dumps({'status': JobStatus.ERROR})}\n\n"
                break
            payload = {"status": job.status, "progress": job.progress}
            if job.status == JobStatus.DONE and job.download_url:
                payload["download_url"] = job.download_url
            if payload != last:
                yield f"data: {json.dumps(payload)}\n\n"
                last = payload
                if job.status in {JobStatus.DONE, JobStatus.ERROR}:
                    break
            await asyncio.sleep(1)

    return StreamingResponse(gen(job_id), media_type="text/event-stream")


# Polling status (fallback when SSE drops)
@app.get("/status/{job_id}")
async def status(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Not found")
    payload = {"status": job.status, "progress": job.progress}
    if job.status == JobStatus.DONE and job.download_url:
        payload["download_url"] = job.download_url
    return payload


@app.get("/download/{job_id}")
async def download(job_id: str):
    job = JOBS.get(job_id)
    if not job or not job.out_path or job.status != JobStatus.DONE:
        raise HTTPException(400, "Not ready")
    if job.expires_at and datetime.utcnow() > job.expires_at:
        raise HTTPException(410, "Expired")
    if not os.path.exists(job.out_path):
        raise HTTPException(404, "File missing")
    return FileResponse(job.out_path, filename=f"compressed_{job_id}.mp4", media_type="video/mp4")


@app.get("/terms", response_class=HTMLResponse)
async def terms(request: Request):
    return templates.TemplateResponse("terms.html", {"request": request})


@app.get("/healthz")
async def health():
    return {"ok": True}
