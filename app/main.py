"""
MailSized – upload → Stripe → async 2-pass ffmpeg (size-targeted) → download
Adds live progress via SSE and robust email sending.

Set these env vars on Render:

  PUBLIC_BASE_URL=https://mailsized.com        # your primary URL
  STRIPE_SECRET_KEY=sk_test_...                # required
  STRIPE_WEBHOOK_SECRET=whsec_...              # required

  # Optional email (choose ONE path)
  # ---- Mailgun ----
  MAILGUN_API_KEY=...
  MAILGUN_DOMAIN=yourverifieddomain.com
  SENDER_EMAIL=no-reply@yourverifieddomain.com
  # ---- SMTP (fallback) ----
  EMAIL_SMTP_HOST=smtp.gmail.com
  EMAIL_SMTP_PORT=587         # 587 (STARTTLS) or 465 (SSL)
  EMAIL_SMTP_USE_SSL=false    # "true" if 465, else "false"
  EMAIL_SMTP_USE_TLS=true     # "true" if 587, else "false"
  EMAIL_USERNAME=...
  EMAIL_PASSWORD=...

  # (Optional) AdSense flags used by templates
  ENABLE_ADSENSE=false
  CONSENT_GIVEN=false
  ADSENSE_CLIENT_ID=
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
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
from starlette.middleware.security import SecurityMiddleware

# ───────────────────────────────────────────────────────────────────────────────
# Config
# ───────────────────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailsized")

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

BASE_DIR = os.path.dirname(__file__)
TEMP_UPLOAD_DIR = (
    "/opt/render/project/src/temp_uploads"
    if "RENDER" in os.environ
    else os.path.join(BASE_DIR, "temp_uploads")
)
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)

# FFmpeg binaries (installed by build.sh into /opt/render/project/src/bin)
FFMPEG = os.getenv("FFMPEG_PATH", "/opt/render/project/src/bin/ffmpeg")
FFPROBE = os.getenv("FFPROBE_PATH", "/opt/render/project/src/bin/ffprobe")

# Limits & pricing
MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi"}

# target attachment sizes (MB) for each provider
PROVIDER_TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}

# provider base prices by tier index [≤5m, ≤10m, ≤20m]
PROVIDER_PRICING = {
    "gmail":   [1.99, 2.99, 4.49],
    "outlook": [2.19, 3.29, 4.99],
    "other":   [2.49, 3.99, 5.49],
}

PUBLIC_BASE_URL = (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/")

def _adsense_context_for_request(request: Request) -> dict:
    """Return template vars including a CSP nonce-aware AdSense loader."""
    nonce = getattr(request.state, "csp_nonce", "")
    adsense_tag = ""
    if ENABLE_ADSENSE and ADSENSE_CLIENT_ID:
        adsense_tag = (
            f'<script async nonce="{nonce}" '
            f'src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={ADSENSE_CLIENT_ID}" '
            'crossorigin="anonymous"></script>'
        )
    return {
        "adsense_tag": adsense_tag,
        "adsense_client_id": ADSENSE_CLIENT_ID,
        "adsense_sidebar_slot": ADSENSE_SIDEBAR_SLOT,
        "csp_nonce": nonce,
        "GA_ID": GA_MEASUREMENT_ID,
    }

# And change your render helper (or each view) to use it:
def render(name: str, request: Request, **ctx) -> str:
    tpl = env.get_template(name)
    ctx = {**_adsense_context_for_request(request), **ctx}
    return tpl.render(**ctx)


def calculate_pricing(duration_sec: int, file_size_bytes: int) -> Dict[str, Any]:
    """
    Tier caps: ≤5/≤10/≤20 min and ≤500MB/≤1GB/≤2GB respectively.
    Returns a dict with tier (1..3), base Gmail price (UI swaps per provider),
    and the max caps echoed back for the sidebar.
    """
    minutes = duration_sec / 60
    mb_size = file_size_bytes / (1024 * 1024)
    if minutes <= 5 and mb_size <= 500:
        return {"tier": 1, "price": 1.99, "max_length_min": 5, "max_size_mb": 500}
    if minutes <= 10 and mb_size <= 1024:
        return {"tier": 2, "price": 2.99, "max_length_min": 10, "max_size_mb": 1024}
    if minutes <= 20 and mb_size <= 2048:
        return {"tier": 3, "price": 4.99, "max_length_min": 20, "max_size_mb": 2048}
    raise ValueError("Video exceeds allowed limits for all tiers.")


# ───────────────────────────────────────────────────────────────────────────────
# Job model
# ───────────────────────────────────────────────────────────────────────────────

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
        self.progress: float = 0.0  # 0..1
        self.output_path: Optional[str] = None
        self.created_at = datetime.utcnow()
        self.download_expiry: Optional[datetime] = None

    @property
    def download_url(self) -> Optional[str]:
        if self.status != JobStatus.DONE or not self.output_path:
            return None
        return f"/download/{self.job_id}"


jobs: Dict[str, Job] = {}


# ───────────────────────────────────────────────────────────────────────────────
# FFmpeg helpers
# ───────────────────────────────────────────────────────────────────────────────

async def probe_duration(path: str) -> float:
    try:
        proc = await asyncio.create_subprocess_exec(
            FFPROBE, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        return float((out or b"0").decode().strip() or "0")
    except Exception as exc:
        log.warning("ffprobe failed: %s", exc)
        return 0.0


def compute_bitrates_for_target(duration_sec: float, target_mb: int) -> tuple[int, int]:
    """
    Simple size-targeting:
    - pick total bits = target_mb MiB
    - reserve ~5% mux overhead
    - keep audio at ~80 kbps AAC
    - clamp video between 150..2500 kbps
    """
    total_bits = target_mb * 1024 * 1024 * 8
    audio_kbps = 80
    overhead = 0.05
    duration = max(1.0, float(duration_sec))
    video_bits = total_bits * (1.0 - overhead) - (audio_kbps * 1000 * duration)
    v_kbps = max(150, int(video_bits / 1000 / duration))
    v_kbps = min(v_kbps, 2500)
    return v_kbps, audio_kbps


async def _run_ffmpeg_pass(args: list[str], duration_sec: float, start_w: float, end_w: float, job: Job) -> None:
    """
    Run ffmpeg and update progress by parsing -progress pipe:2 (stderr) out_time_ms.
    """
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    while True:
        line = await proc.stderr.readline()
        if not line:
            break
        s = line.decode().strip()
        if s.startswith("out_time_ms="):
            try:
                out_ms = int(s.split("=", 1)[1])
                frac = min(1.0, max(0.0, out_ms / (duration_sec * 1_000_000.0)))
                job.progress = start_w + (end_w - start_w) * frac
            except Exception:
                pass
    await proc.wait()
    if proc.returncode != 0:
        rem = await proc.stderr.read()
        raise RuntimeError(f"ffmpeg failed (rc={proc.returncode}): {rem.decode()}")


async def ffmpeg_two_pass(src: str, dst: str, duration_sec: float, target_mb: int, job: Job) -> None:
    v_kbps, a_kbps = compute_bitrates_for_target(duration_sec, target_mb)
    log.info("2-pass target ~%d MB: v=%dkbps a=%dkbps", target_mb, v_kbps, a_kbps)

    passlog = os.path.join(TEMP_UPLOAD_DIR, f"ffpass_{uuid.uuid4().hex}")
    common = [
        FFMPEG, "-hide_banner", "-y",
        "-threads", "1",              # be nice on Hobby plan
        "-i", src,
        "-c:v", "libx264", "-preset", "veryfast",
        "-movflags", "+faststart",
        "-progress", "pipe:2", "-loglevel", "error",
    ]

    # Pass 1: no audio, null muxer
    args1 = common + ["-b:v", f"{v_kbps}k", "-pass", "1", "-passlogfile", passlog, "-an", "-f", "mp4", os.devnull]
    await _run_ffmpeg_pass(args1, duration_sec, 0.00, 0.45, job)

    # Pass 2: with audio
    args2 = common + [
        "-b:v", f"{v_kbps}k", "-pass", "2", "-passlogfile", passlog,
        "-c:a", "aac", "-b:a", f"{a_kbps}k",
        dst,
    ]
    await _run_ffmpeg_pass(args2, duration_sec, 0.45, 0.98, job)

    # cleanup pass logs
    for ext in (".log", ".mbtree"):
        try:
            os.remove(passlog + ext)
        except FileNotFoundError:
            pass


# ───────────────────────────────────────────────────────────────────────────────
# Email
# ───────────────────────────────────────────────────────────────────────────────

async def send_email(recipient: str, download_url: str) -> None:
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your compressed video is ready"
    body = f"Your video is ready for the next 30 minutes:\n{download_url}"

    # Mailgun first
    mg_api_key = os.getenv("MAILGUN_API_KEY")
    mg_domain = os.getenv("MAILGUN_DOMAIN")
    if mg_api_key and mg_domain and recipient:
        def _send_mg():
            r = requests.post(
                f"https://api.mailgun.net/v3/{mg_domain}/messages",
                auth=("api", mg_api_key),
                data={
                    "from": sender, "to": [recipient],
                    "subject": subject, "text": body,
                    "h:Auto-Submitted": "auto-generated",
                    "h:X-Auto-Response-Suppress": "All",
                    "h:Reply-To": "no-reply@mailsized.com",
                }, timeout=10,
            )
            r.raise_for_status()
        try:
            await asyncio.to_thread(_send_mg)
            log.info("Email sent via Mailgun to %s", recipient)
            return
        except Exception as exc:
            log.warning("Mailgun failed: %s", exc)

    # SMTP fallback
    host = os.getenv("EMAIL_SMTP_HOST")
    port = int(os.getenv("EMAIL_SMTP_PORT", "0") or 0)
    use_ssl = os.getenv("EMAIL_SMTP_USE_SSL", "false").lower() == "true"
    use_tls = os.getenv("EMAIL_SMTP_USE_TLS", "false").lower() == "true"
    username = os.getenv("EMAIL_USERNAME")
    password = os.getenv("EMAIL_PASSWORD")
    if not (host and port and username and password and recipient):
        log.info("Email skipped: SMTP not fully configured")
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
        if use_ssl:
            with smtplib.SMTP_SSL(host, port) as s:
                s.login(username, password)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port) as s:
                if use_tls:
                    s.starttls()
                s.login(username, password)
                s.send_message(msg)
        log.info("Email sent via SMTP to %s", recipient)
    except Exception as exc:
        log.warning("SMTP send failed: %s", exc)


# ───────────────────────────────────────────────────────────────────────────────
# Job runner
# ───────────────────────────────────────────────────────────────────────────────

async def run_job(job: Job) -> None:
    try:
        job.status = JobStatus.PROCESSING
        job.progress = 0.02
        await asyncio.sleep(0.3)

        job.status = JobStatus.COMPRESSING
        out_name = f"compressed_{job.job_id}.mp4"
        job.output_path = os.path.join(TEMP_UPLOAD_DIR, out_name)
        target_mb = int(job.target_size_mb or PROVIDER_TARGETS_MB.get(job.provider or "gmail", 25))
        await ffmpeg_two_pass(job.file_path, job.output_path, job.duration, target_mb, job)

        job.status = JobStatus.FINALIZING
        job.progress = 0.99
        await asyncio.sleep(0.4)

        ttl = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
        job.download_expiry = datetime.utcnow() + timedelta(minutes=ttl)
        job.status = JobStatus.DONE
        job.progress = 1.0

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


# ───────────────────────────────────────────────────────────────────────────────
# FastAPI app
# ───────────────────────────────────────────────────────────────────────────────

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)
# --- Security headers (keeps app secure while allowing GA/Ads if enabled) ---
CSP = (
    "default-src 'self'; "
    # Scripts you actually use:
    "script-src 'self' https://cdnjs.cloudflare.com "
    "https://www.googletagmanager.com https://www.google-analytics.com "
    # If you run AdSense, uncomment the next line:
    # "https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net "
    "'unsafe-inline'; "
    # Inline styles in templates + cdn css:
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
    # Images and pixels:
    "img-src 'self' data: https://www.google-analytics.com https://www.googletagmanager.com; "
    # XHR / beacons (GA):
    "connect-src 'self' https://www.google-analytics.com https://www.googletagmanager.com; "
    # Fonts:
    "font-src 'self' data: https://cdnjs.cloudflare.com; "
    # We redirect to Stripe; if you ever embed stripe, these help:
    "frame-src 'self' https://js.stripe.com https://checkout.stripe.com; "
    # Disallow everything else by default:
    "object-src 'none'; "
    "base-uri 'self'; "
    "frame-ancestors 'self';"
)
app.add_middleware(
    SecurityMiddleware,
    content_security_policy=CSP,
    content_security_policy_report_only=False,   # set True temporarily if you want to test/report
    referrer_policy="strict-origin-when-cross-origin",
    permissions_policy="camera=(), microphone=(), geolocation=()",
    strict_transport_security="max-age=31536000; includeSubDomains",
    x_content_type_options=True,
    x_frame_options="DENY",
)

app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "adsense_tag": adsense_script_tag(), "adsense_client_id": os.getenv("ADSENSE_CLIENT_ID", "")},
    )

# Render health checks sometimes use HEAD /
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
                os.remove(temp_path)
                raise HTTPException(400, "File exceeds 2GB limit")

    duration = await probe_duration(temp_path)
    if duration > MAX_DURATION_SEC:
        os.remove(temp_path)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    pricing = calculate_pricing(int(duration), total)
    job = Job(job_id, temp_path, duration, total, pricing)
    jobs[job_id] = job

    return JSONResponse(
        {
            "job_id": job_id,
            "duration_sec": duration,
            "size_bytes": total,
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
            if meta.get("target_size_mb"):
                try:
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
        last_status = None
        last_progress = -1
        while True:
            job = jobs.get(jid)
            if not job:
                yield f"data: {json.dumps({'status': JobStatus.ERROR, 'message': 'Job not found'})}\n\n"
                break
            payload: Dict[str, Any] = {"status": job.status}
            pct = int(round(job.progress * 100))
            if pct != last_progress:
                payload["progress"] = pct
                last_progress = pct
            if job.status == JobStatus.DONE and job.download_url:
                payload["download_url"] = job.download_url
            if job.status != last_status or "progress" in payload:
                yield f"data: {json.dumps(payload)}\n\n"
                last_status = job.status
                if job.status in {JobStatus.DONE, JobStatus.ERROR}:
                    break
            await asyncio.sleep(0.5)
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
    filename = f"compressed_video_{job.job_id}.mp4"
    return FileResponse(job.output_path, filename=filename, media_type="video/mp4")

@app.get("/healthz")
async def health() -> Dict[str, str]:
    return {"status": "ok"}
