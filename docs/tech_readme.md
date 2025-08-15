# MailSized Technical Overview

This document gives developers a quick tour of the MailSized codebase.

## End‑to‑End Flow
1. **Upload** – `/upload` saves the file, probes duration/size via `ffprobe` and
   returns an `upload_id` plus pricing info. Uploads use XHR so the UI can show a
   live progress bar.
2. **Checkout** – The browser POSTs `{upload_id, provider, extras, email}` to
   `/checkout`. The server computes the authoritative price and creates a job.
   In development (no Stripe key) the job starts immediately and the response
   contains a fake success URL with `job_id`.
3. **Compression** – `run_job` transcodes the video with ffmpeg, emitting
   Server‑Sent Events from `/events/{job_id}` so the front‑end can show progress.
   On completion a `download_url` is pushed to the client and an email is sent
   in the background. Jobs are cleaned up after `DOWNLOAD_TTL_MIN` minutes.

## Key Modules
- `app/main.py` – FastAPI application, pricing helpers, job worker and SSE.
- `app/static/script.js` – Upload handling, pricing calculator, checkout and SSE
  client logic.
- `app/templates/index.html` – Minimal HTML with steps UI and progress bars.

## Pricing
Pricing is based on uploaded size tier × provider plus optional upsells and
10% tax. Tiers: `≤500MB`, `≤1GB`, `≤2GB`. Providers:

| Provider | Tier 1 | Tier 2 | Tier 3 |
|---------|-------|-------|-------|
| Gmail   | $1.99 | $2.99 | $4.49 |
| Outlook | $2.19 | $3.29 | $4.99 |
| Other   | $2.49 | $3.99 | $5.49 |

Extras: Priority +$0.75, Transcript +$1.50.

## Cleanup
Jobs and temporary files are deleted by `cleanup_job` scheduled by
`_schedule_cleanup`. The interval is controlled by `DOWNLOAD_TTL_MIN` (default
30 minutes).
