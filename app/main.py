"""
MailSized – FastAPI backend
- Upload -> Stripe Checkout -> FFmpeg 2‑pass -> Download
- Real‑time progress via SSE (with heartbeats so the UI never stalls)
- Works on Render (uses ./bin/ffmpeg, ./bin/ffprobe from build.sh)
- Mounts static/templates from the app/ folder
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass, field
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

# -------------------- Config --------------------

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("mailsized")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

# Render writable scratch
TEMP_ROOT = Path("/opt/render/project/src/temp_uploads") if os.getenv("RENDER") else (BASE_DIR / "temp_uploads")
TEMP_ROOT.mkdir(parents=True, exist_ok=True)

# ffmpeg paths installed by build.sh
FFMPEG = str(Path("/opt/render/project/src/bin/ffmpeg")) if os.getenv("RENDER") else str(Path.cwd() / "bin/ffmpeg")
FFPROBE = str(Path("/opt/render/project/src/bin/ffprobe")) if os.getenv("RENDER") else str(Path.cwd() / "bin/ffprobe")

# Limits (your caps)
MAX_BYTES = 2 * 1024 * 1024 * 1024      # ≤2GB
MAX_DURATION = 20 * 60                  # ≤20 min
ALLOWED = {".mp4", ".mov", ".mkv", ".avi"}

# Targets in MB for each provider (email attachment caps)
PROVIDER_TARGETS_MB = {"gmail": 25, "outlook": 20, "other": 15}

# Provider pricing per tier (≤5 / ≤10 / ≤20 min and within size bucket)
PROVIDER_PRICING = {
    "gmail":   [1.99, 2.99, 4.99],
    "outlook": [2.19, 3.29, 4.99],
    "other":   [2.49, 3.99, 5.49],
}

# Stripe
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

# Download link TTL
DOWNLOAD_TTL_MIN = int(os.getenv("DOWNLOAD_TTL_MIN", "30"))

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

# -------------------- Data model --------------------

class JobStatus:
    QUEUED = "queued"
    PROCESSING = "processing"
    COMPRESSING = "compressing"
    FINALIZING = "finalizing"
    DONE = "done"
    ERROR = "error"

@dataclass
class Job:
    job_id: str
    in_path: str
    size_bytes: int
    duration: float
    pricing: Dict[str, Any]
    provider: Optional[str] = None
    priority: bool = False
    transcript: bool = False
    email: Optional[str] = None
    target_mb: int = 25

    status: str = JobStatus.QUEUED
    progress: float = 0.0             # 0..100
    progress_note: str = "Starting"
    out_path: Optional[str] = None
    download_expiry: Optional[datetime] = None

    # internals for the compressor task
    _kill: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    @property
    def download_url(self) -> Optional[str]:
        if self.status == JobStatus.DONE and self.out_path:
            return f"/download/{self.job_id}"
        return None


JOBS: Dict[str, Job] = {}

# -------------------- Helpers --------------------

async def ffprobe_duration(path: str) -> float:
    """Return duration in seconds (0.0 if unknown)."""
    try:
        p = await asyncio.create_subprocess_exec(
            FFPROBE, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await p.communicate()
        return float(stdout.decode().strip())
    except Exception as e:
        log.warning("ffprobe failed: %s", e)
        return 0.0

def choose_tier(seconds: int, bytes_: int) -> Dict[str, Any]:
    """Tier by duration+size with your caps: ≤500MB/≤1GB/≤2GB and ≤5/≤10/≤20 min."""
    minutes = seconds / 60
    mb = bytes_ / (1024 * 1024)
    if minutes <= 5 and mb <= 500:
        return {"tier": 1, "max_length_min": 5,  "max_size_mb": 500}
    if minutes <= 10 and mb <= 1024:
        return {"tier": 2, "max_length_min": 10, "max_size_mb": 1024}
    if minutes <= 20 and mb <= 2048:
        return {"tier": 3, "max_length_min": 20, "max_size_mb": 2048}
    raise ValueError("Video exceeds allowed limits (≤20 min and ≤2GB).")

def calc_provider_price(provider: str, tier: int, priority: bool, transcript: bool) -> float:
    base = PROVIDER_PRICING[provider][tier - 1]
    upsells = (0.75 if priority else 0.0) + (1.50 if transcript else 0.0)
    return round(base + upsells, 2)

def calc_target_bitrate_kbps(target_mb: int, duration_sec: float) -> int:
    """
    Convert requested target MB to an overall bitrate budget, then allocate audio/video.
    We keep audio ~80kbps (aac) and give the rest to video.
    """
    if duration_sec <= 0:
        return 800  # safe default
    total_bits = target_mb * 1024 * 1024 * 8
    total_kbps = max(int(total_bits / duration_sec / 1000), 120)
    # leave 80 kbps for audio, never let video drop under 120 kbps
    return max(total_kbps - 80, 120)

async def send_email(recipient: str, download_url: str) -> None:
    """Mailgun if configured; fall back to SMTP with STARTTLS if provided."""
    sender = os.getenv("SENDER_EMAIL", "no-reply@mailsized.com")
    subject = "Your MailSized video is ready"
    body = f"Your compressed video will remain available for {DOWNLOAD_TTL_MIN} minutes:\n{download_url}"

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
                timeout=15,
            )
            r.raise_for_status()
            log.info("Email sent via Mailgun to %s", recipient)
            return
        except Exception as e:
            log.warning("Mailgun failed: %s", e)

    host = os.getenv("EMAIL_SMTP_HOST")
    port = os.getenv("EMAIL_SMTP_PORT")
    user = os.getenv("EMAIL_USERNAME")
    pwd = os.getenv("EMAIL_PASSWORD")
    if host and port and user and pwd:
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
                s.ehlo()
                s.login(user, pwd)
                s.sendmail(sender, [recipient], msg.as_string())
            log.info("Email sent via SMTP to %s", recipient)
        except Exception as e:
            log.warning("SMTP failed: %s", e)

# -------------------- Compression task --------------------

async def run_ffmpeg_two_pass(job: Job) -> None:
    """2-pass ABR with progress parsing -> update job.progress continuously."""
    job.status = JobStatus.COMPRESSING
    job.progress_note = "Analyzing"

    # Compute bitrate for target size
    v_kbps = calc_target_bitrate_kbps(job.target_mb, job.duration)
    a_kbps = 80
    total_target = v_kbps + a_kbps
    log.info("2-pass target ~%d MB: v=%dkbps a=%dkbps", job.target_mb, v_kbps, a_kbps)

    # Output path
    out_path = Path(TEMP_ROOT) / f"compressed_{job.job_id}.mp4"
    job.out_path = str(out_path)

    # First pass: no audio, null muxer
    passlog = str(Path(TEMP_ROOT) / f"ff2pass_{job.job_id}")
    pass1_cmd = [
        FFMPEG, "-y", "-hide_banner",
        "-i", job.in_path,
        "-c:v", "libx264", "-preset", "medium", "-b:v", f"{v_kbps}k",
        "-pass", "1", "-passlogfile", passlog,
        "-an",
        "-f", "mp4",  # write to null via -f null? Some builds lack 'null' in mp4 path; safer: small fifo
        "-progress", "pipe:1", "-nostats",
        "-vf", "scale='min(1280,iw)':-2",  # keep under 1280 wide for email friendliness
        "-movflags", "+faststart",
        "-tune", "film",  # reasonable default
        "-map_metadata", "-1",
        "-f", "null",
        "-"
    ]

    # Second pass: write the actual file with audio
    pass2_cmd = [
        FFMPEG, "-y", "-hide_banner",
        "-i", job.in_path,
        "-c:v", "libx264", "-preset", "medium", "-b:v", f"{v_kbps}k",
        "-pass", "2", "-passlogfile", passlog,
        "-c:a", "aac", "-b:a", f"{a_kbps}k",
        "-movflags", "+faststart",
        "-map_metadata", "-1",
        "-vf", "scale='min(1280,iw)':-2",
        "-progress", "pipe:1", "-nostats",
        str(out_path)
    ]

    async def _run_and_track(cmd: list[str], phase_start: float, phase_end: float) -> None:
        """
        Run one ffmpeg command and map its out_time_ms to [%] between [phase_start, phase_end].
        Sends heartbeats even if ffmpeg stays quiet for a bit.
        """
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        last_emit = 0.0
        while True:
            line = await proc.stdout.readline()
            if not line:
                # heartbeat while waiting for process to exit
                await asyncio.sleep(0.3)
                if proc.returncode is not None:
                    break
                # still running; nudge UI
                pct = max(job.progress, phase_start + 0.1)
                job.progress = min(pct, phase_end - 1.0)
                continue

            txt = line.decode(errors="ignore").strip()
            # Example keys: out_time_ms=1234567, speed=1.23x, progress=continue
            if txt.startswith("out_time_ms="):
                try:
                    ms = float(txt.split("=", 1)[1])
                    frac = min(ms / (job.duration * 1000.0), 0.999)
                    job.progress = phase_start + (phase_end - phase_start) * frac
                    job.progress_note = "Compressing…"
                except Exception:
                    pass
            elif txt.startswith("speed="):
                job.progress_note = f"Working ({txt.split('=',1)[1]})"
            # throttle updates a bit
            now = asyncio.get_event_loop().time()
            if now - last_emit > 0.2:
                last_emit = now

        rc = await proc.wait()
        if rc != 0:
            err = (await proc.stderr.read()).decode(errors="ignore")[:800]
            raise RuntimeError(f"ffmpeg failed (rc={rc}). {err}")

    # Phase 1: 0 -> 40%
    await _run_and_track(pass1_cmd, 0.0, 40.0)
    # Phase 2: 40% -> 98%
    await _run_and_track(pass2_cmd, 40.0, 98.0)

    # tidy pass logs
    for ext in (".log", ".log.mbtree"):
        try:
            Path(passlog + ext).unlink(missing_ok=True)
        except Exception:
            pass

    # finalize
    job.status = JobStatus.FINALIZING
    job.progress = 99.0
    await asyncio.sleep(0.5)
    job.download_expiry = datetime.utcnow() + timedelta(minutes=DOWNLOAD_TTL_MIN)
    job.status = JobStatus.DONE
    job.progress = 100.0
    job.progress_note = "Complete"

async def run_job(job: Job) -> None:
    try:
        job.status = JobStatus.PROCESSING
        await asyncio.sleep(0.3)
        await run_ffmpeg_two_pass(job)
        # notify via email (best effort)
        if job.email:
            try:
                await send_email(job.email, job.download_url or "")
            except Exception as e:
                log.warning("email after job failed: %s", e)
        # schedule cleanup when TTL passes
        asyncio.create_task(cleanup_job(job.job_id))
    except Exception as e:
        log.exception("job %s failed: %s", job.job_id, e)
        job.status = JobStatus.ERROR
        job.progress_note = "Error"

async def cleanup_job(job_id: str) -> None:
    job = JOBS.get(job_id)
    if not job or not job.download_expiry:
        return
    wait = (job.download_expiry - datetime.utcnow()).total_seconds()
    if wait > 0:
        await asyncio.sleep(wait)
    try:
        if job.out_path and Path(job.out_path).exists():
            Path(job.out_path).unlink(missing_ok=True)
        if Path(job.in_path).exists():
            Path(job.in_path).unlink(missing_ok=True)
    except Exception as e:
        log.warning("cleanup failed: %s", e)
    JOBS.pop(job_id, None)

# -------------------- FastAPI app --------------------

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"]
)

# Mount app assets
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@app.get("/", response_class=HTMLResponse)
async def home(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "adsense_tag": adsense_script_tag(), "adsense_client_id": os.getenv("ADSENSE_CLIENT_ID", "")},
    )

@app.get("/terms", response_class=HTMLResponse)
async def terms(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("terms.html", {"request": request})

# -------- Upload --------

@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> JSONResponse:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED:
        raise HTTPException(400, f"Unsupported file type: {ext}")

    job_id = str(uuid.uuid4())
    in_path = str(TEMP_ROOT / f"upload_{job_id}{ext}")

    # stream to disk and enforce size cap
    total = 0
    with open(in_path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
            if total > MAX_BYTES:
                try:
                    f.close()
                    Path(in_path).unlink(missing_ok=True)
                finally:
                    pass
                raise HTTPException(400, "File exceeds 2GB limit")

    duration = await ffprobe_duration(in_path)
    if duration <= 0:
        # allow unknown, but still tier on size only (use last bucket that fits)
        duration = 60.0  # placeholder to avoid div/0 in bitrate calc
    if duration > MAX_DURATION:
        Path(in_path).unlink(missing_ok=True)
        raise HTTPException(400, "Video exceeds 20 minute limit")

    tier_info = choose_tier(int(duration), total)
    # Base (Gmail) price – UI will recompute when user flips provider
    base_price = PROVIDER_PRICING["gmail"][tier_info["tier"] - 1]

    job = Job(
        job_id=job_id,
        in_path=in_path,
        size_bytes=total,
        duration=duration,
        pricing={"tier": tier_info["tier"], "price": base_price, **tier_info},
    )
    JOBS[job_id] = job

    return JSONResponse({
        "job_id": job_id,
        "duration_sec": duration,
        "size_bytes": total,
        "tier": tier_info["tier"],
        "price": base_price,
        "max_length_min": tier_info["max_length_min"],
        "max_size_mb": tier_info["max_size_mb"],
    })

# -------- Checkout --------

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
        raise HTTPException(400, "Invalid job_id")
    if provider not in PROVIDER_TARGETS_MB:
        raise HTTPException(400, "Unknown provider")

    job.provider = provider
    job.priority = bool(priority)
    job.transcript = bool(transcript)
    job.email = (email or "").strip() or None
    job.target_mb = PROVIDER_TARGETS_MB[provider]

    tier = job.pricing["tier"]
    total = calc_provider_price(provider, tier, job.priority, job.transcript)
    amount_cents = int(round(total * 100))

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
        metadata={
            "job_id": job_id,
            "provider": provider,
            "priority": str(job.priority),
            "transcript": str(job.transcript),
            "email": job.email or "",
            "target_size_mb": str(job.target_mb),
            "tier": str(tier),
        },
    )

    return JSONResponse({"checkout_url": session.url, "session_id": session.id})

# -------- Stripe webhook --------

@app.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    if not secret:
        return JSONResponse(status_code=400, content={"detail": "Webhook secret not configured"})
    try:
        event = stripe.Webhook.construct_event(payload, sig, secret)
    except Exception as e:
        log.warning("webhook signature failed: %s", e)
        return JSONResponse(status_code=400, content={"detail": "bad signature"})

    if event["type"] == "checkout.session.completed":
        obj = event["data"]["object"]
        meta = obj.get("metadata", {}) or {}
        job_id = meta.get("job_id")
        job = JOBS.get(job_id)
        if job:
            # restore just in case
            job.provider = meta.get("provider") or job.provider
            job.priority = (meta.get("priority") or "").lower() == "true" or job.priority
            job.transcript = (meta.get("transcript") or "").lower() == "true" or job.transcript
            email = (meta.get("email") or "").strip()
            job.email = email or job.email
            try:
                t = int(meta.get("target_size_mb", job.target_mb))
                job.target_mb = t
            except Exception:
                pass
            asyncio.create_task(run_job(job))
            log.info("Started job %s after Stripe payment", job.job_id)
        else:
            log.warning("webhook for unknown job_id=%s", job_id)
    return {"received": True}

# -------- Events (SSE) --------

@app.get("/events/{job_id}")
async def events(job_id: str):
    async def gen():
        # Always send something at least every 1s (heartbeat) so EventSource stays alive.
        last = None
        while True:
            job = JOBS.get(job_id)
            if not job:
                yield "data: {}\n\n"
                break

            payload: Dict[str, Any] = {
                "status": job.status,
                "progress": round(job.progress, 1),
                "note": job.progress_note,
            }
            if job.status == JobStatus.DONE and job.download_url:
                payload["download_url"] = job.download_url

            js = json.dumps(payload)
            if js != last:
                yield f"data: {js}\n\n"
                last = js

            if job.status in {JobStatus.DONE, JobStatus.ERROR}:
                break
            await asyncio.sleep(1.0)

    return StreamingResponse(gen(), media_type="text/event-stream")

# -------- Download --------

@app.get("/download/{job_id}")
async def download(job_id: str):
    job = JOBS.get(job_id)
    if not job or not job.out_path:
        raise HTTPException(404, "Not found")
    if job.status != JobStatus.DONE:
        raise HTTPException(400, "Not ready")
    if job.download_expiry and datetime.utcnow() > job.download_expiry:
        raise HTTPException(410, "Link expired")
    if not Path(job.out_path).exists():
        raise HTTPException(404, "File missing")
    return FileResponse(job.out_path, filename=f"compressed_{job.job_id}.mp4", media_type="video/mp4")

@app.get("/healthz")
async def health():
    # also verify ffmpeg is present
    ok = Path(FFMPEG).exists() and Path(FFPROBE).exists()
    return {"status": "ok", "ffmpeg": ok}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
