# app/main.py
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import smtplib
import subprocess
import time
import uuid
from dataclasses import dataclass, field
from email.message import EmailMessage
from pathlib import Path
from typing import AsyncIterator, Dict, Optional, Tuple

import requests
import stripe
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from jinja2 import Environment, FileSystemLoader, select_autoescape

# ------------ Config / Env ------------
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000")
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")  # if set, we verify
OWNER_EMAIL = os.environ.get("OWNER_EMAIL", "")

# Optional rate limit toggle (off by default so behavior doesn't change)
ENABLE_RATE_LIMIT = os.getenv("ENABLE_RATE_LIMIT", "0") == "1"

# Paths (all under /app)
APP_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = APP_DIR / "templates"
STATIC_DIR = APP_DIR / "static"
DATA_DIR = APP_DIR / ".." / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
for p in (DATA_DIR, UPLOAD_DIR, OUTPUT_DIR):
    p.mkdir(parents=True, exist_ok=True)

# ffmpeg / ffprobe installed by build.sh into /opt/render/project/src/bin
BIN_DIR = Path(os.environ.get("BIN_DIR", "/opt/render/project/src/bin"))
FFMPEG = str(BIN_DIR / "ffmpeg")
FFPROBE = str(BIN_DIR / "ffprobe")

# ------------ App ------------
app = FastAPI()

# NOTE: Keep current permissive CORS to avoid breaking your flow.
# Later, tighten to:
# allow_origins=["https://mailsized.com", "https://www.mailsized.com"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=["*"])

if not STATIC_DIR.exists():
    raise RuntimeError(f"Static directory missing: {STATIC_DIR}")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
# Keep /media static mount to preserve current behavior (emails/UI use it)
app.mount("/media", StaticFiles(directory=str(OUTPUT_DIR)), name="media")

env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=select_autoescape(["html", "xml"]),
)

# ------------ Attachment caps / limits ------------
PROVIDER_CAP_MB = {"gmail": 25, "outlook": 20, "other": 15}
PROVIDER_TARGETS_MB = PROVIDER_CAP_MB

MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60  # 20 minutes
DOWNLOAD_TTL_MIN = float(os.getenv("DOWNLOAD_TTL_MIN", "30"))


class JobStatus:
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    ERROR = "error"


# ------------ Size-based pricing (server-authoritative) ------------
def price_cents_for_size(size_bytes: int) -> int:
    mb = size_bytes / (1024 * 1024)
    if mb <= 250:
        return 199
    if mb <= 750:
        return 399
    if mb <= 1280:  # ~1.25GB
        return 599
    return 799  # up to 2GB


@dataclass
class UploadMeta:
    upload_id: str
    src_path: Path
    size_bytes: int
    duration_sec: float
    width: int
    height: int
    email: Optional[str] = None
    provider: str = "gmail"
    priority: bool = False
    transcript: bool = False


@dataclass
class JobState:
    job_id: str
    upload: UploadMeta
    status: str = JobStatus.QUEUED
    progress: float = 0.0
    message: str = ""
    out_path: Optional[Path] = None
    error: Optional[str] = None
    q: asyncio.Queue = field(default_factory=asyncio.Queue)


UPLOADS: Dict[str, UploadMeta] = {}
JOBS: Dict[str, JobState] = {}
uploads = UPLOADS
jobs = JOBS


# ------------ Helpers ------------
def _run(cmd: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        shlex.split(cmd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )


def probe_info(path: str) -> Tuple[float, int, int]:
    if not Path(path).exists():
        raise FileNotFoundError(path)
    d = _run(f"{FFPROBE} -v error -show_entries format=duration -of json {shlex.quote(path)}")
    dur = 0.0
    try:
        dur = float(json.loads(d.stdout or "{}").get("format", {}).get("duration", 0.0))
    except Exception:
        pass
    s = _run(
        f"{FFPROBE} -v error -select_streams v:0 -show_entries stream=width,height -of json {shlex.quote(path)}"
    )
    width = height = 0
    try:
        st = json.loads(s.stdout or "{}").get("streams", [{}])[0]
        width = int(st.get("width") or 0)
        height = int(st.get("height") or 0)
    except Exception:
        pass
    return max(dur, 0.0), width, height


def probe_duration(path: str) -> float:
    dur, _, _ = probe_info(path)
    return dur


def choose_target(provider: str, size_bytes: int) -> int:
    """Determine target size in bytes for a given provider.

    The original implementation ignored the file's current size and would always
    return the provider's maximum attachment size minus some headroom.  That
    meant a small file could be "upscaled" to a much larger size during
    compression, which is undesirable.  Additionally, provider lookups were
    case-sensitive, so ``"Gmail"`` would fall back to the default instead of the
    Gmail limits.

    This version normalizes the provider name and ensures that we never suggest
    a target larger than the current file size.
    """

    cap_mb = PROVIDER_CAP_MB.get((provider or "").lower(), PROVIDER_CAP_MB["other"])
    # Determine provider cap with 1.5MB headroom; clamp to non-negative values.
    target_bytes = max(0, int((cap_mb - 1.5) * 1024 * 1024))
    # Do not enlarge small files – keep the original size if it's below the cap.
    return min(max(size_bytes, 0), target_bytes)


def compute_bitrates(duration_sec: float, target_bytes: int) -> Tuple[int, int]:
    if duration_sec <= 0:
        duration_sec = 120.0
    total_bits = int(target_bytes * 8 * 0.94)  # ~6% container overhead
    audio_bps = 80_000  # 80 kbps AAC
    video_bps = max(int(total_bits / duration_sec) - audio_bps, 400_000)
    return video_bps, audio_bps


def decide_two_pass(duration_sec: float, video_bps: int) -> bool:
    if duration_sec >= 120:
        return True
    if video_bps <= 600_000:
        return True
    return False


def auto_scale(width: int, height: int, video_bps: int) -> Tuple[int, int]:
    if width <= 0 or height <= 0:
        return (960, 540) if video_bps < 600_000 else (1280, 720)
    target_w, target_h = width, height
    px = width * height
    if video_bps < 500_000:
        target_w, target_h = 854, 480
    elif video_bps < 900_000:
        target_w, target_h = 1280, 720
    else:
        if px > 1920 * 1080:
            target_w, target_h = 1920, 1080
    target_w -= target_w % 2
    target_h -= target_h % 2
    return max(target_w, 2), max(target_h, 2)


def put(job: JobState, **payload):
    job.q.put_nowait(payload)


async def sse_stream(job: JobState) -> AsyncIterator[bytes]:
    yield f"data: {json.dumps({'type':'state','progress':round(job.progress,1),'status':job.status,'message':job.message})}\n\n".encode()
    last_heartbeat = time.time()
    while True:
        try:
            item = await asyncio.wait_for(job.q.get(), timeout=5.0)
            yield f"data: {json.dumps(item)}\n\n".encode()
            if item.get("status") in ("done", "error"):
                await asyncio.sleep(0.25)
                return
        except asyncio.TimeoutError:
            if time.time() - last_heartbeat >= 5:
                yield b": keep-alive\n\n"
                last_heartbeat = time.time()


# --- Pricing helpers (server-authoritative) ---
SIZE_TIERS_MB = [500, 1000, 2000]  # ≤500MB, ≤1GB, ≤2GB
PRICES_BY_PROVIDER = {
    "gmail": [1.99, 2.99, 4.49],
    "outlook": [2.19, 3.29, 4.99],
    "other": [2.49, 3.99, 5.49],
}
UPSELLS = {"priority": 0.75, "transcript": 1.50}
TAX_RATE = 0.10


def _tier_index_from_bytes(n_bytes: int) -> int:
    mb = n_bytes / (1024 * 1024)
    if mb <= 500:
        return 0
    if mb <= 1000:
        return 1
    return 2


def compute_order_total_cents(
    provider: str, size_bytes: int, priority: bool, transcript: bool
) -> int:
    prov = (provider or "gmail").lower()
    table = PRICES_BY_PROVIDER.get(prov, PRICES_BY_PROVIDER["gmail"])
    tier_idx = _tier_index_from_bytes(size_bytes)
    base = float(table[tier_idx])
    if priority:
        base += UPSELLS["priority"]
    if transcript:
        base += UPSELLS["transcript"]
    total = base + (base * TAX_RATE)
    return max(100, int(round(total * 100)))


# ------------ Email ------------
MAILGUN_KEY = os.environ.get("MAILGUN_API_KEY", "")
MAILGUN_DOMAIN = os.environ.get("MAILGUN_DOMAIN", "")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "noreply@mailsized.com")

SMTP_HOST = os.environ.get("EMAIL_SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("EMAIL_SMTP_PORT", "587") or "587")
SMTP_USER = os.environ.get("EMAIL_USERNAME", "")
SMTP_PASS = os.environ.get("EMAIL_PASSWORD", "")


def send_contact_message(from_email: str, subject: str, body: str) -> None:
    if not OWNER_EMAIL:
        return
    if MAILGUN_KEY and MAILGUN_DOMAIN:
        try:
            r = requests.post(
                f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
                auth=("api", MAILGUN_KEY),
                data={
                    "from": f"MailSized Contact <{SENDER_EMAIL or 'no-reply@mailsized.com'}>",
                    "to": [OWNER_EMAIL],
                    "subject": f"[MailSized Contact] {subject}",
                    "text": f"From: {from_email}\n\n{body}",
                },
                timeout=10,
            )
            r.raise_for_status()
            return
        except Exception:
            pass
    if SMTP_HOST and SMTP_USER and SMTP_PASS:
        try:
            msg = EmailMessage()
            msg["From"] = SENDER_EMAIL or "no-reply@mailsized.com"
            msg["To"] = OWNER_EMAIL
            msg["Subject"] = f"[MailSized Contact] {subject}"
            msg.set_content(f"From: {from_email}\n\n{body}")
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
                s.starttls()
                s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
        except Exception:
            return


def send_email_download(to_email: str, download_url: str) -> None:
    subject = "Your MailSized download"
    body = f"Your file is ready: {download_url}\n"
    if MAILGUN_KEY and MAILGUN_DOMAIN:
        try:
            r = requests.post(
                f"https://api.mailgun.net/v3/{MAILGUN_DOMAIN}/messages",
                auth=("api", MAILGUN_KEY),
                data={
                    "from": SENDER_EMAIL or "no-reply@mailsized.com",
                    "to": [to_email],
                    "subject": subject,
                    "text": body,
                    "h:Auto-Submitted": "auto-generated",
                    "h:X-Auto-Response-Suppress": "All",
                    "h:Reply-To": "no-reply@mailsized.com",
                },
                timeout=10,
            )
            r.raise_for_status()
            return
        except Exception:
            pass
    if SMTP_HOST and SMTP_USER and SMTP_PASS:
        try:
            msg = EmailMessage()
            msg["From"] = SENDER_EMAIL or "no-reply@mailsized.com"
            msg["To"] = to_email
            msg["Subject"] = subject
            msg["Auto-Submitted"] = "auto-generated"
            msg["X-Auto-Response-Suppress"] = "All"
            msg["Reply-To"] = "no-reply@mailsized.com"
            msg.set_content(body)
            with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as s:
                s.starttls()
                s.login(SMTP_USER, SMTP_PASS)
                s.send_message(msg)
        except Exception:
            return


async def send_email(to_email: str, download_url: str) -> None:
    await asyncio.to_thread(send_email_download, to_email, download_url)


# ------------ Security headers (no behavior change) ------------
@app.middleware("http")
async def security_headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    # keep CSP friendly to your current use of CDN CSS/JS and inline styles
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "img-src 'self' data:; "
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; "
        "script-src 'self' https://cdnjs.cloudflare.com; "
        "font-src 'self' https://cdnjs.cloudflare.com; "
        "connect-src 'self';"
    )
    return resp


# ------------ Optional basic rate limit (off by default) ------------
_RATE = {"tokens": {}, "capacity": 20, "refill": 20, "per": 60.0}  # generous defaults


ADSENSE_CLIENT_ID = "ca-pub-7488512497606071"


def _adsense_context() -> dict[str, str]:
    """Return template variables for AdSense."""
    tag = (
        f'<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client={ADSENSE_CLIENT_ID}" '
        'crossorigin="anonymous"></script>'
    )
    return {"adsense_tag": tag, "adsense_client_id": ADSENSE_CLIENT_ID}


@app.middleware("http")
async def basic_rate_limit(request: Request, call_next):
    if not ENABLE_RATE_LIMIT:
        return await call_next(request)
    ip = request.client.host if request.client else "anon"
    now = time.time()
    b = _RATE["tokens"].get(ip, {"t": now, "tokens": _RATE["capacity"]})
    elapsed = now - b["t"]
    b["tokens"] = min(_RATE["capacity"], b["tokens"] + elapsed * (_RATE["refill"] / _RATE["per"]))
    b["t"] = now
    cost = 3 if request.url.path == "/upload" else 1
    if b["tokens"] < cost:
        return JSONResponse({"error": "rate_limited"}, status_code=429)
    b["tokens"] -= cost
    _RATE["tokens"][ip] = b
    return await call_next(request)


# ------------ Views ------------
@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    template = env.get_template("index.html")
    ctx = _adsense_context()
    job_id = request.query_params.get("job_id") or ""
    paid = request.query_params.get("paid") == "1"
    return template.render(**ctx, paid=paid, job_id=job_id)


@app.get("/terms", response_class=HTMLResponse)
def terms() -> str:
    template = env.get_template("terms.html")
    return template.render(**_adsense_context())


# --- Extra pages (kept as in your current app) ---
@app.get("/how-it-works", response_class=HTMLResponse)
def how_it_works(request: Request):
    template = env.get_template("how-it-works.html")
    return template.render(**_adsense_context())


@app.get("/privacy", response_class=HTMLResponse)
def privacy(request: Request):
    template = env.get_template("privacy.html")
    return template.render(**_adsense_context())


@app.get("/contact", response_class=HTMLResponse)
def contact_get(request: Request):
    template = env.get_template("contact.html")
    sent = request.query_params.get("sent") == "1"
    ctx = _adsense_context()
    return template.render(**ctx, sent=sent)


@app.get("/blogs", response_class=HTMLResponse)
def blogs_index():
    template = env.get_template("blogs.html")
    return template.render(**_adsense_context())


@app.get("/blog/meet-mailsized", response_class=HTMLResponse)
def blog_meet_mailsized():
    template = env.get_template("blog-meet-mailsized.html")
    return template.render(**_adsense_context())


@app.post("/contact")
async def contact_post(
    user_email: str = Form(...),
    subject: str = Form(...),
    message: str = Form(...),
):
    if not user_email or "@" not in user_email:
        raise HTTPException(status_code=400, detail="Valid email required.")
    if not subject.strip() or not message.strip():
        raise HTTPException(status_code=400, detail="Subject and message are required.")
    send_contact_message(user_email.strip(), subject.strip(), message.strip())
    return RedirectResponse(url="/contact?sent=1", status_code=303)


# ------------ API ------------
@app.post("/upload")
async def upload(file: UploadFile = File(...), email: Optional[str] = Form(None)):
    if not file.filename:
        raise HTTPException(400, "Missing filename")
    if not (file.content_type or "").startswith("video/"):
        raise HTTPException(400, "Unsupported file type")

    upload_id = str(uuid.uuid4())
    # Keep behavior: still save to uploads dir; switch to neutral extension to avoid odd filenames
    temp_path = UPLOAD_DIR / f"{upload_id}.src"

    max_bytes = int(MAX_SIZE_GB * 1024 * 1024 * 1024)
    written = 0
    with temp_path.open("wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > max_bytes:
                temp_path.unlink(missing_ok=True)
                raise HTTPException(400, "File exceeds 2GB limit")
            f.write(chunk)

    try:
        duration, width, height = probe_info(str(temp_path))
    except Exception as e:
        raise HTTPException(400, f"Probe failed: {e}")

    if duration > MAX_DURATION_SEC:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    meta = UploadMeta(
        upload_id=upload_id,
        src_path=temp_path,
        size_bytes=temp_path.stat().st_size,
        duration_sec=duration,
        width=width,
        height=height,
        email=email or None,
    )
    UPLOADS[upload_id] = meta

    return JSONResponse(
        {
            "ok": True,
            "upload_id": upload_id,
            "duration_sec": duration,
            "size_bytes": meta.size_bytes,
            "width": width,
            "height": height,
            "price_cents": price_cents_for_size(meta.size_bytes),
        }
    )


@app.post("/checkout")
async def checkout(request: Request):
    """Create job + Stripe Checkout URL; return JSON { url }."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    upload_id = (body.get("upload_id") or "").strip()
    provider = (body.get("provider") or "gmail").lower()
    email = (body.get("email") or "").strip()
    priority = bool(body.get("priority"))
    transcript = bool(body.get("transcript"))

    if not upload_id or upload_id not in UPLOADS:
        return JSONResponse({"error": "upload not found"}, status_code=404)
    if not email:
        return JSONResponse({"error": "email_required"}, status_code=400)

    u = UPLOADS[upload_id]
    u.provider = provider
    u.priority = priority
    u.transcript = transcript
    u.email = email

    price_cents = compute_order_total_cents(
        provider=provider, size_bytes=u.size_bytes, priority=priority, transcript=transcript
    )

    job_id = str(uuid.uuid4())
    job = JobState(job_id=job_id, upload=u, status=JobStatus.QUEUED, progress=0.0)
    JOBS[job_id] = job

    if not stripe.api_key:
        asyncio.create_task(run_job(job))
        fake_url = f"{PUBLIC_BASE_URL}?paid=1&job_id={job_id}"
        return JSONResponse({"url": fake_url})

    try:
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[
                {
                    "price_data": {
                        "currency": "usd",
                        "product_data": {"name": "MailSized Video Compression"},
                        "unit_amount": price_cents,
                    },
                    "quantity": 1,
                }
            ],
            customer_email=email,
            success_url=f"{PUBLIC_BASE_URL}?paid=1&job_id={job_id}",
            cancel_url=f"{PUBLIC_BASE_URL}?canceled=1&job_id={job_id}",
            metadata={"upload_id": upload_id, "job_id": job_id},
        )
        return JSONResponse({"url": session.url})
    except Exception:
        return JSONResponse({"error": "checkout_create_failed"}, status_code=500)


@app.post("/stripe/webhook")
async def stripe_webhook(
    request: Request, stripe_signature: str = Header(None, alias="stripe-signature")
):
    """
    If STRIPE_WEBHOOK_SECRET is set, verify signature. Otherwise, keep current
    permissive behavior (do not break existing deployments).
    """
    payload = await request.body()

    event = None
    if STRIPE_WEBHOOK_SECRET:
        try:
            event = stripe.Webhook.construct_event(
                payload=payload,
                sig_header=stripe_signature or "",
                secret=STRIPE_WEBHOOK_SECRET,
            )
        except Exception:
            # Invalid signature; ignore silently to mimic Stripe 200 behavior.
            return JSONResponse({"ok": True}, status_code=200)
    else:
        # Fallback: parse JSON without verification (current behavior)
        try:
            event = json.loads(payload.decode() or "{}")
        except Exception:
            event = {}

    event_type = event.get("type") if isinstance(event, dict) else event["type"]
    if event_type != "checkout.session.completed":
        return {"ok": True}

    obj = (
        event.get("data", {}).get("object", {})
        if isinstance(event, dict)
        else event["data"]["object"]
    )
    metadata = obj.get("metadata", {}) or {}
    upload_id = metadata.get("upload_id")
    job_id = metadata.get("job_id")

    if not upload_id or upload_id not in UPLOADS:
        return {"ok": True}

    job = JOBS.get(job_id) if job_id else None
    if not job:
        job_id = job_id or str(uuid.uuid4())
        job = JobState(
            job_id=job_id, upload=UPLOADS[upload_id], status=JobStatus.QUEUED, progress=0.0
        )
        JOBS[job_id] = job

    asyncio.create_task(run_job(job))
    return {"ok": True, "job_id": job.job_id}


@app.get("/events/{job_id}")
async def events(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        dummy = JobState(
            job_id=job_id,
            upload=UploadMeta(
                upload_id="", src_path=Path(""), size_bytes=0, duration_sec=0, width=0, height=0
            ),
            status=JobStatus.ERROR,
            message="Unknown job",
        )
        put(dummy, type="state", status=JobStatus.ERROR, progress=0, message="Unknown job")
        return StreamingResponse(sse_stream(dummy), media_type="text/event-stream")
    return StreamingResponse(sse_stream(job), media_type="text/event-stream")


@app.get("/download/{job_id}")
def download(job_id: str):
    """
    Keep current behavior: return a JSON with a /media URL so your front-end and
    emails continue to work unchanged.
    """
    job = JOBS.get(job_id)
    if not job or job.status != JobStatus.DONE or not job.out_path:
        raise HTTPException(404, "Not ready")
    return JSONResponse({"ok": True, "url": f"{PUBLIC_BASE_URL}/media/{job.out_path.name}"})


async def cleanup_job(job_id: str) -> None:
    job = JOBS.pop(job_id, None)
    if not job:
        return
    up = job.upload
    try:
        if up.upload_id in UPLOADS:
            UPLOADS.pop(up.upload_id, None)
        if up.src_path.exists():
            up.src_path.unlink(missing_ok=True)
    except Exception:
        pass
    try:
        if job.out_path and job.out_path.exists():
            job.out_path.unlink(missing_ok=True)
    except Exception:
        pass


async def _schedule_cleanup(job_id: str) -> None:
    await asyncio.sleep(DOWNLOAD_TTL_MIN * 60)
    await cleanup_job(job_id)


# ------------ Worker ------------
def _preexec_ulimits():
    """
    Add gentle resource limits to the ffmpeg child process.
    Safe defaults; no behavior change expected.
    """
    try:
        import resource

        # CPU 30 minutes
        resource.setrlimit(resource.RLIMIT_CPU, (1800, 1800))
        # Address space ~2 GB
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        # File descriptors
        resource.setrlimit(resource.RLIMIT_NOFILE, (512, 512))
    except Exception:
        # If not available on the platform, ignore.
        pass


async def run_job(job: JobState):
    u = job.upload
    job.status = JobStatus.RUNNING
    put(job, type="state", status=JobStatus.RUNNING, progress=0.0, message="Starting…")

    try:
        target_bytes = choose_target(u.provider, u.size_bytes)
        v_bps, a_bps = compute_bitrates(u.duration_sec, target_bytes)
        do_two_pass = decide_two_pass(u.duration_sec, v_bps)
        tw, th = auto_scale(u.width, u.height, v_bps)

        out_name = f"{job.job_id}.mp4"
        out_path = OUTPUT_DIR / out_name
        if out_path.exists():
            out_path.unlink(missing_ok=True)

        vf = f"scale=w={tw}:h={th}:force_original_aspect_ratio=decrease:flags=bicubic"
        common = [
            FFMPEG,
            "-y",
            "-i",
            str(u.src_path),
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast" if u.priority else "faster",
            "-movflags",
            "+faststart",
            "-c:a",
            "aac",
            "-b:a",
            str(a_bps),
            "-max_muxing_queue_size",
            "9999",
        ]

        def percent_from_out_time_ms(line: str) -> Optional[float]:
            m = re.match(r"out_time_ms=(\d+)", line.strip())
            if m:
                ms = int(m.group(1))
                if u.duration_sec > 0:
                    return min(99.0, (ms / 1_000_000.0) / u.duration_sec * 100.0)
            return None

        async def run_and_stream(cmd: list[str]) -> int:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                "-progress",
                "pipe:1",
                "-nostats",
                "-loglevel",
                "error",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                preexec_fn=_preexec_ulimits,  # sandbox-ish
            )
            last_emit = 0.0
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                txt = line.decode("utf-8", "ignore")
                if "out_time_ms=" in txt:
                    pct = percent_from_out_time_ms(txt)
                    if pct is not None and pct - last_emit >= 1.0:
                        job.progress = pct
                        put(
                            job,
                            type="progress",
                            progress=round(pct, 1),
                            status="running",
                            message="Compressing…",
                        )
                        last_emit = pct
            return await proc.wait()

        if do_two_pass:
            rc1 = await run_and_stream(
                common + ["-b:v", str(v_bps), "-pass", "1", "-f", "mp4", "/dev/null"]
            )
            if rc1 != 0:
                raise RuntimeError("FFmpeg pass 1 failed")
            rc2 = await run_and_stream(common + ["-b:v", str(v_bps), "-pass", "2", str(out_path)])
            if rc2 != 0:
                raise RuntimeError("FFmpeg pass 2 failed")
        else:
            rc = await run_and_stream(
                common
                + [
                    "-b:v",
                    str(v_bps),
                    "-maxrate",
                    str(int(v_bps * 1.2)),
                    "-bufsize",
                    str(int(v_bps * 2)),
                    str(out_path),
                ]
            )
            if rc != 0:
                raise RuntimeError("FFmpeg failed")

        if not out_path.exists() or out_path.stat().st_size <= 0:
            raise RuntimeError("Output missing")

        # Finalize: broadcast URL immediately; email in parallel
        job.progress = 100.0
        job.status = JobStatus.DONE
        job.out_path = out_path
        dl_url = f"{PUBLIC_BASE_URL}/media/{out_path.name}"

        put(
            job,
            type="state",
            status=JobStatus.DONE,
            progress=100.0,
            message="Complete",
            download_url=dl_url,
        )

        if u.email:
            asyncio.create_task(asyncio.to_thread(send_email_download, u.email, dl_url))

        asyncio.create_task(_schedule_cleanup(job.job_id))

    except Exception as e:
        job.status = JobStatus.ERROR
        job.error = str(e)
        put(job, type="state", status=JobStatus.ERROR, progress=job.progress, message=str(e))


# ------------ Health ------------
@app.get("/healthz")
def healthz():
    return {"ok": True}
