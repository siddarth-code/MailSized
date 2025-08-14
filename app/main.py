"""
MailSized – FastAPI app
Upload → Stripe → Encode (single/2-pass) → Email + Download
- Provider size targets: Gmail=25MB, Outlook=20MB, Other=15MB
- Auto single/2-pass selection
- Auto downscale by bitrate ladder
- Guaranteed size with post-encode clamp & retry
- Live % progress via SSE (never stuck at 2%)
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import shutil
import smtplib
import subprocess
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict, Optional, Tuple

import requests
import stripe
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ---------- Paths: make static/templates robust ----------
from pathlib import Path

# Directory of this file: .../app
APP_DIR = Path(__file__).resolve().parent

# Candidates for static/templates (works locally & on Render)
STATIC_CANDIDATES = [
    APP_DIR / "static",                         # app/static  (preferred)
    APP_DIR.parent / "static",                  # repo/static
    Path("/opt/render/project/src/app/static"), # Render common
    Path("/opt/render/project/src/static"),     # Render if moved
]
TEMPLATES_CANDIDATES = [
    APP_DIR / "templates",                         # app/templates (preferred)
    APP_DIR.parent / "templates",                  # repo/templates
    Path("/opt/render/project/src/app/templates"), # Render common
    Path("/opt/render/project/src/templates"),     # Render if moved
]

def _pick_dir(candidates, create_if_missing=False, label=""):
    for d in candidates:
        if d.exists() and d.is_dir():
            return d
    # If nothing exists, optionally create the first candidate to avoid crashes
    d = candidates[0]
    if create_if_missing:
        d.mkdir(parents=True, exist_ok=True)
        logging.warning("'%s' directory not found; created fallback at: %s", label, d)
    else:
        logging.warning("'%s' directory not found; expected one of: %s", label, [str(c) for c in candidates])
    return d

STATIC_DIR = _pick_dir(STATIC_CANDIDATES, create_if_missing=True, label="static")
TEMPLATES_DIR = _pick_dir(TEMPLATES_CANDIDATES, create_if_missing=False, label="templates")

# Temp uploads (Render path vs. local)
if "RENDER" in os.environ:
    TEMP_UPLOAD_DIR = Path("/opt/render/project/src/temp_uploads")
else:
    TEMP_UPLOAD_DIR = APP_DIR / "temp_uploads"
TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Mount static & templates
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


# ---------------------- Logging & env ----------------------

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailsized")

stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

BASE_DIR = os.path.dirname(__file__)
ROOT_DIR = os.path.dirname(BASE_DIR)

# binary discovery (Render build.sh puts ffmpeg/ffprobe into ./bin)
FFMPEG = shutil.which("ffmpeg") or os.path.join(ROOT_DIR, "bin", "ffmpeg")
FFPROBE = shutil.which("ffprobe") or os.path.join(ROOT_DIR, "bin", "ffprobe")

if not os.path.exists(FFMPEG) or not os.path.exists(FFPROBE):
    log.warning("FFmpeg/ffprobe not found on PATH. Expecting them in ./bin via build.sh")

if "RENDER" in os.environ:
    TEMP_DIR = "/opt/render/project/src/temp_uploads"
else:
    TEMP_DIR = os.path.join(ROOT_DIR, "temp_uploads")
os.makedirs(TEMP_DIR, exist_ok=True)

STATIC_DIR = os.path.join(ROOT_DIR, "static")
TEMPLATES_DIR = os.path.join(ROOT_DIR, "templates")

# ---------------------- Limits & Pricing ----------------------

MAX_SIZE_GB = 2
MAX_DURATION_SEC = 20 * 60
ALLOWED_EXT = {".mp4", ".mov", ".mkv", ".avi", ".m4v"}

# Mail provider targets (hard caps)
PROVIDER_TARGET_MB = {"gmail": 25, "outlook": 20, "other": 15}

# Display pricing (the UI swaps base by provider)
PROVIDER_PRICING = {
    "gmail": [1.99, 2.99, 4.99],
    "outlook": [2.19, 3.29, 4.99],
    "other": [2.49, 3.99, 5.49],
}

# ---------------------- Helpers ----------------------


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


async def run(cmd: list[str]) -> Tuple[int, str, str]:
    """Run a command, capture output."""
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    out, err = await proc.communicate()
    return proc.returncode, (out or b"").decode(), (err or b"").decode()


async def ffprobe_info(path: str) -> Dict[str, Any]:
    """Return duration,width,height as floats/ints; safe defaults on error."""
    try:
        code, out, _ = await run(
            [
                FFPROBE,
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                path,
            ]
        )
        if code != 0:
            return {"duration": 0.0, "width": 0, "height": 0}

        data = json.loads(out or "{}")
        # find video stream
        v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
        duration = float(data.get("format", {}).get("duration", 0.0) or 0.0)
        width = int(v.get("width") or 0)
        height = int(v.get("height") or 0)
        return {"duration": duration, "width": width, "height": height}
    except Exception as e:  # noqa: BLE001
        log.warning("ffprobe error: %s", e)
        return {"duration": 0.0, "width": 0, "height": 0}


def even(x: int) -> int:
    return x if x % 2 == 0 else x - 1


def pick_scale(height_src: int, width_src: int, v_kbps: int) -> Tuple[int, int]:
    """
    Simple ladder by available video bitrate.
    Keeps source if already smaller. Always keep even dims.
    """
    # choose target height by bitrate
    if v_kbps <= 550:
        target_h = 360
    elif v_kbps <= 850:
        target_h = 480
    elif v_kbps <= 1300:
        target_h = 540
    elif v_kbps <= 2000:
        target_h = 720
    else:
        target_h = min(height_src, 1080)

    if height_src == 0 or width_src == 0:
        return target_h, even(int(target_h * 16 / 9))  # fallback 16:9

    # if source already <= target, keep source
    if height_src <= target_h:
        return even(height_src), even(width_src)

    # keep aspect ratio
    scale = target_h / float(height_src)
    new_w = int(width_src * scale)
    return even(target_h), even(new_w)


def compute_bitrates(duration_s: float, target_mb: int) -> Tuple[int, int]:
    """
    Compute audio & video bitrates (kbps) to hit a target size.
    Reserve ~2% container overhead. Default audio 80 kbps.
    """
    if duration_s <= 0:
        duration_s = 1.0

    container_overhead = 0.02
    total_bits = target_mb * 1024 * 1024 * 8
    usable_bits = int(total_bits * (1.0 - container_overhead))

    # pick audio: 80 kbps (100 kbps if very long)
    a_kbps = 80 if duration_s <= 900 else 64
    a_bps = a_kbps * 1000

    v_bps = max(120_000, (usable_bits - a_bps * duration_s) / duration_s)
    v_kbps = int(v_bps // 1000)

    # clamp extremes
    v_kbps = max(120, min(v_kbps, 5000))
    return a_kbps, v_kbps


def choose_strategy(v_kbps: int, duration_s: float) -> str:
    """
    Strategy selection:
    - If bitrate budget is tight OR the video is longer => 2-pass ABR for size certainty.
    - Otherwise 1-pass CBR-ish (still with maxrate/bufsize) for speed.
    """
    if v_kbps <= 1400 or duration_s >= 180:
        return "two_pass"
    return "single_pass"


@dataclass
class Job:
    id: str
    src_path: str
    size_bytes: int
    duration: float
    width: int
    height: int
    tier: int
    base_price: float
    provider: Optional[str] = None
    target_mb: int = 25
    email: Optional[str] = None
    priority: bool = False
    transcript: bool = False

    status: str = "queued"
    progress: float = 0.0
    note: str = ""
    out_path: Optional[str] = None
    expires_at: Optional[datetime] = None
    created_at: datetime = field(default_factory=lambda: datetime.utcnow())


jobs: Dict[str, Job] = {}


def price_for(duration_s: float, size_bytes: int) -> Dict[str, Any]:
    minutes = duration_s / 60.0
    mb = size_bytes / (1024 * 1024)
    if minutes <= 5 and mb <= 500:
        return {"tier": 1, "gmail_price": 1.99, "max_size_mb": 500, "max_len": 5}
    if minutes <= 10 and mb <= 1024:
        return {"tier": 2, "gmail_price": 2.99, "max_size_mb": 1024, "max_len": 10}
    if minutes <= 20 and mb <= 2048:
        return {"tier": 3, "gmail_price": 4.99, "max_size_mb": 2048, "max_len": 20}
    raise ValueError("Video exceeds allowed limits (≤20 min & ≤2GB).")


async def send_email(recipient: str, url: str) -> None:
    subj = "Your compressed video is ready"
    body = f"Your video is ready for {os.getenv('DOWNLOAD_TTL_MIN','30')} minutes:\n{url}"

    # Mailgun first
    mg_key = os.getenv("MAILGUN_API_KEY", "")
    mg_domain = os.getenv("MAILGUN_DOMAIN", "")
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    if mg_key and mg_domain and recipient:
        try:
            r = requests.post(
                f"https://api.mailgun.net/v3/{mg_domain}/messages",
                auth=("api", mg_key),
                data={
                    "from": sender,
                    "to": [recipient],
                    "subject": subj,
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
            log.warning("Mailgun failed: %s", e)

    # Fallback SMTP
    host = os.getenv("EMAIL_SMTP_HOST")
    port = os.getenv("EMAIL_SMTP_PORT")
    user = os.getenv("EMAIL_USERNAME")
    pwd = os.getenv("EMAIL_PASSWORD")
    if not (host and port and user and pwd and recipient):
        log.info("No email credentials; skipping email.")
        return

    try:
        msg = MIMEMultipart()
        msg["From"] = sender
        msg["To"] = recipient
        msg["Subject"] = subj
        msg["Auto-Submitted"] = "auto-generated"
        msg["X-Auto-Response-Suppress"] = "All"
        msg["Reply-To"] = "no-reply@mailsized.com"
        msg.attach(MIMEText(body, "plain"))

        with smtplib.SMTP(host, int(port)) as s:
            s.ehlo()
            s.starttls()
            s.ehlo()
            s.login(user, pwd)
            s.send_message(msg)
        log.info("Email sent via SMTP to %s", recipient)
    except Exception as e:  # noqa: BLE001
        log.warning("SMTP failed: %s", e)


async def encode_with_progress(
    job: Job,
    target_mb: int,
    a_kbps: int,
    v_kbps: int,
    strategy: str,
) -> None:
    """Run ffmpeg with proper scaling + ABR, send % updates; guarantee size with clamp retry."""
    # scale choice
    tgt_h, tgt_w = pick_scale(job.height, job.width, v_kbps)

    out_mp4 = os.path.join(TEMP_DIR, f"compressed_{job.id}.mp4")
    passlog = os.path.join(TEMP_DIR, f"ffpass_{job.id}")

    # Make sure any prior leftovers are cleared
    for p in (out_mp4, passlog + "-0.log", passlog + "-0.log.mbtree"):
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception:
            pass

    def build_common_vopts(kbps: int, preset: str = "medium") -> list[str]:
        # cbr-ish abr with caps; yuv420p for compatibility; faststart for email/cloud
        return [
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-profile:v", "high",
            "-level", "4.0",
            "-b:v", f"{kbps}k",
            "-maxrate", f"{int(kbps*1.45)}k",
            "-bufsize", f"{int(kbps*2.9)}k",
            "-preset", preset,
        ]

    vf = ["-vf", f"scale={tgt_w}:{tgt_h}:flags=lanczos"]
    aopts = ["-c:a", "aac", "-b:a", f"{a_kbps}k", "-ac", "2"]
    faststart = ["-movflags", "+faststart"]
    progress = ["-progress", "pipe:1", "-nostats"]

    # update helper (never “stuck”)
    def pct_from_time(out_time_ms: Optional[int], base: float, span: float) -> float:
        if out_time_ms is None or job.duration <= 0:
            return min(99.0, base)  # minimal tick
        return min(99.0, base + span * (out_time_ms / (job.duration * 1000.0)))

    async def run_and_track(cmd: list[str], base: float, span: float) -> None:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        # parse -progress key=value stream
        out_time_ms: Optional[int] = None
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode(errors="ignore").strip()
            if text.startswith("out_time_ms="):
                try:
                    out_time_ms = int(text.split("=", 1)[1].strip())
                except Exception:
                    out_time_ms = None
                # update progress
                job.progress = pct_from_time(out_time_ms, base, span)
                job.note = f"{int(job.progress)}% • {v_kbps}k video • {tgt_w}x{tgt_h}"
            elif text == "progress=end":
                job.progress = min(99.0, base + span)
            # yield to event loop
            await asyncio.sleep(0)

        await proc.wait()
        if proc.returncode != 0:
            _, _, err = await run(["bash", "-lc", "true"])  # no-op to await fully
            raise RuntimeError(f"ffmpeg failed (rc={proc.returncode})")

    # choose strategy
    if strategy == "two_pass":
        # PASS 1 (video only → /dev/null)
        cmd1 = [
            FFMPEG, "-y", "-i", job.src_path, *vf,
            *build_common_vopts(v_kbps, preset="medium"),
            "-pass", "1", "-passlogfile", passlog,
            "-an",  # speed up pass 1
            *progress,
            "-f", "mp4",
            "/dev/null",
        ]
        job.status = "compressing"
        job.note = "Pass 1/2…"
        await run_and_track(cmd1, base=0.0, span=48.0)

        # PASS 2 (mux audio) → file
        cmd2 = [
            FFMPEG, "-y", "-i", job.src_path, *vf,
            *build_common_vopts(v_kbps, preset="medium"),
            "-pass", "2", "-passlogfile", passlog,
            *aopts, *faststart, *progress,
            out_mp4,
        ]
        job.note = "Pass 2/2…"
        await run_and_track(cmd2, base=48.0, span=51.0)
    else:
        # single pass
        cmd = [
            FFMPEG, "-y", "-i", job.src_path, *vf,
            *build_common_vopts(v_kbps, preset="fast"),
            *aopts, *faststart, *progress,
            out_mp4,
        ]
        job.status = "compressing"
        job.note = "Encoding…"
        await run_and_track(cmd, base=0.0, span=99.0)

    # post-encode: guarantee size
    try:
        out_bytes = os.path.getsize(out_mp4)
    except Exception:
        out_bytes = 0

    cap_bytes = target_mb * 1024 * 1024
    if out_bytes == 0 or out_bytes > cap_bytes:
        # one corrective retry at ~8% lower video bitrate
        v_kbps_retry = max(120, int(v_kbps * 0.92))
        log.info("Retrying to enforce cap: %sMB → lower v_kbps %s→%s", target_mb, v_kbps, v_kbps_retry)
        cmd_retry = [
            FFMPEG, "-y", "-i", job.src_path, *vf,
            *build_common_vopts(v_kbps_retry, preset="medium"),
            *aopts, *faststart, *progress,
            out_mp4,
        ]
        job.note = "Size clamp retry…"
        await encode_retry(cmd_retry, job)

        # recheck
        try:
            out_bytes = os.path.getsize(out_mp4)
        except Exception:
            out_bytes = 0
        if out_bytes == 0 or out_bytes > cap_bytes:
            raise HTTPException(500, "Unable to meet email size cap; please try a shorter clip.")

    job.out_path = out_mp4
    job.progress = 100.0
    job.status = "finalizing"
    job.note = "Finalizing…"


async def encode_retry(cmd: list[str], job: Job) -> None:
    """Small helper for the clamp retry run with progress."""
    async def run_and_track_retry():
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            if line.startswith(b"out_time_ms="):
                try:
                    out_ms = int(line.decode().split("=", 1)[1].strip())
                    job.progress = min(99.0, 80.0 + 19.0 * (out_ms / (job.duration * 1000.0)))
                    job.note = f"Clamp {int(job.progress)}%"
                except Exception:
                    pass
            await asyncio.sleep(0)
        await proc.wait()
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg retry failed")

    await run_and_track_retry()


async def process_job(job: Job) -> None:
    try:
        job.status = "processing"

        # compute final targets
        target_mb = job.target_mb
        a_kbps, v_kbps = compute_bitrates(job.duration, target_mb)
        strategy = choose_strategy(v_kbps, job.duration)
        log.info("%s: strategy=%s a=%sk v=%sk target=%sMB", job.id, strategy, a_kbps, v_kbps, target_mb)

        await encode_with_progress(job, target_mb, a_kbps, v_kbps, strategy)

        # finish
        ttl_min = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))
        job.expires_at = datetime.utcnow() + timedelta(minutes=ttl_min)
        job.status = "done"
        job.note = "Ready"

        # email if requested
        if job.email:
            base_url = os.getenv("PUBLIC_BASE_URL", "").strip() or ""
            link = f"{base_url.rstrip('/')}/download/{job.id}" if base_url else f"/download/{job.id}"
            await send_email(job.email, link)

        # schedule cleanup
        asyncio.create_task(cleanup(job.id))
    except Exception as e:  # noqa: BLE001
        log.exception("Job %s failed: %s", job.id, e)
        job.status = "error"
        job.note = "Encoding failed"


async def cleanup(job_id: str) -> None:
    job = jobs.get(job_id)
    if not job:
        return
    delay = 0
    if job.expires_at:
        delay = max(0, int((job.expires_at - datetime.utcnow()).total_seconds()))
    await asyncio.sleep(delay or 1800)  # 30m fallback
    try:
        if job.out_path and os.path.exists(job.out_path):
            os.remove(job.out_path)
        if os.path.exists(job.src_path):
            os.remove(job.src_path)
    except Exception:
        pass
    jobs.pop(job_id, None)
    log.info("Cleaned up %s", job_id)

# ---------------------- FastAPI ----------------------

app = FastAPI()
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)


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
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported type: {ext}")
    job_id = str(uuid.uuid4())
    dst = os.path.join(TEMP_DIR, f"upload_{job_id}{ext}")

    # stream save with hard cap
    max_bytes = MAX_SIZE_GB * 1024 * 1024 * 1024
    total = 0
    with open(dst, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
            if total > max_bytes:
                f.close()
                os.remove(dst)
                raise HTTPException(400, "File exceeds 2GB limit")

    meta = await ffprobe_info(dst)
    duration = float(meta.get("duration") or 0.0)
    width = int(meta.get("width") or 0)
    height = int(meta.get("height") or 0)

    if duration > MAX_DURATION_SEC:
        os.remove(dst)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    pr = price_for(duration, total)
    job = Job(
        id=job_id,
        src_path=dst,
        size_bytes=total,
        duration=duration,
        width=width,
        height=height,
        tier=pr["tier"],
        base_price=pr["gmail_price"],
    )
    jobs[job_id] = job

    return JSONResponse(
        {
            "job_id": job_id,
            "duration_sec": duration,
            "size_bytes": total,
            "tier": pr["tier"],
            "price": pr["gmail_price"],
            "max_length_min": pr["max_len"],
            "max_size_mb": pr["max_size_mb"],
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
        raise HTTPException(400, "Invalid job")
    if provider not in PROVIDER_TARGET_MB:
        raise HTTPException(400, "Unknown provider")

    job.provider = provider
    job.target_mb = PROVIDER_TARGET_MB[provider]
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = (email or "").strip() or None

    tier = job.tier
    base = float(PROVIDER_PRICING[provider][tier - 1])
    upsell = (0.75 if job.priority else 0.0) + (1.50 if job.transcript else 0.0)
    total = round(base + upsell, 2)

    base_url = os.getenv("PUBLIC_BASE_URL", "").strip() or str(request.base_url).rstrip("/")
    success = f"{base_url}/?paid=1&job_id={job.id}"
    cancel = f"{base_url}/?canceled=1&job_id={job.id}"

    session = stripe.checkout.Session.create(
        mode="payment",
        line_items=[
            {
                "price_data": {
                    "currency": "usd",
                    "product_data": {"name": f"MailSized (Tier {tier})"},
                    "unit_amount": int(total * 100),
                },
                "quantity": 1,
            }
        ],
        success_url=success,
        cancel_url=cancel,
        metadata={
            "job_id": job.id,
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
    secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    if not secret:
        return JSONResponse(status_code=400, content={"detail": "Webhook secret missing"})
    try:
        event = stripe.Webhook.construct_event(payload, sig, secret)
    except Exception as e:  # noqa: BLE001
        log.warning("Stripe signature fail: %s", e)
        return JSONResponse(status_code=400, content={"detail": "Bad signature"})

    if event["type"] == "checkout.session.completed":
        meta = (event["data"]["object"] or {}).get("metadata") or {}
        job_id = meta.get("job_id", "")
        job = jobs.get(job_id)
        if job:
            # restore in case
            job.provider = meta.get("provider") or job.provider
            job.priority = (meta.get("priority") or "").lower() == "true"
            job.transcript = (meta.get("transcript") or "").lower() == "true"
            email = (meta.get("email") or "").strip()
            if email:
                job.email = email
            ts = meta.get("target_size_mb")
            if ts:
                try:
                    job.target_mb = int(ts)
                except Exception:
                    pass
            # fire background processor
            asyncio.create_task(process_job(job))
            log.info("Started job %s after Stripe payment", job_id)
        else:
            log.warning("Webhook for unknown job %s", job_id)
    return {"received": True}


@app.get("/events/{job_id}")
async def events(job_id: str):
    async def gen():
        last_pct = -1
        while True:
            job = jobs.get(job_id)
            if not job:
                yield f"data: {json.dumps({'status':'error','message':'Job not found'})}\n\n"
                break

            payload: Dict[str, Any] = {"status": job.status, "note": job.note, "percent": round(job.progress, 1)}

            # only ship on change or until done
            if int(job.progress) != last_pct or job.status in {"done", "error"}:
                if job.status == "done" and job.out_path:
                    payload["download_url"] = f"/download/{job.id}"
                yield f"data: {json.dumps(payload)}\n\n"
                last_pct = int(job.progress)
                if job.status in {"done", "error"}:
                    break

            await asyncio.sleep(0.8)

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/download/{job_id}")
async def download(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != "done" or not job.out_path:
        raise HTTPException(400, "Not ready")
    if job.expires_at and datetime.utcnow() > job.expires_at:
        raise HTTPException(410, "Link expired")
    if not os.path.exists(job.out_path):
        raise HTTPException(404, "File missing")
    fname = f"compressed_{job.id}.mp4"
    return FileResponse(job.out_path, filename=fname, media_type="video/mp4")


@app.get("/healthz")
async def health():
    return {"ok": True}


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    port = int(os.getenv("PORT", "8000"))
    # Ensure ./bin is on PATH for Render
    os.environ["PATH"] = f"{os.getenv('PATH','')}:{os.path.join(ROOT_DIR, 'bin')}"
    uvicorn.run(app, host="0.0.0.0", port=port)
