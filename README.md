# MailSized – Video Compression Service

MailSized is a self‑hosted tool for compressing large video files so they can be sent as email attachments.  It supports modern formats (MP4, MOV, MKV and AVI), respects common provider limits (25 MB for Gmail, 20 MB for Outlook and 15 MB for other providers) and charges a small per‑upload fee based on the size or duration of your video.

This repository contains both the FastAPI backend and the FastHTML/Jinja2 frontend.  When a user uploads a video the server probes its size and duration using `ffprobe`, determines the appropriate pricing tier and displays a checkout form.  After payment the server compresses the file down to the target size, streams live status updates to the client via Server‑Sent Events (SSE) and finally provides a pre‑signed download link.  Optionally the service can send the resulting file to the user’s email address.  Placeholder slots for AdSense have been reserved in the template and are only activated when the corresponding environment flags are set.

## Features

- ✅ Compress videos up to **2 GB** or **20 minutes** in length
- ✅ Tiered pricing with three levels:
  - **Tier 1** – 0-500 MB → **$1.99**
  - **Tier 2** – 501 mb - 1 GB → **$2.99**
  - **Tier 3** – ≤ 1.01 GB - 2 GB → **$4.99**
  (Jobs larger than 2 GB or over 20 minutes are rejected.)
- ✅ Optional upsells: **Priority processing (+$0.75)** and **Transcript (+$1.50)**
- ✅ Live stepper UI showing **Upload → Payment → Compression → Download**
- ✅ Server‑Sent Event feed for real‑time job status updates
- ✅ Temporary storage with a configurable download TTL (default 30 minutes)
- ✅ Email notification with attachment or link when compression finishes
- ✅ AdSense placeholders (desktop sidebar and mobile inline) that only load ads when `ENABLE_ADSENSE=true` and the user has given consent

## Development

This project uses a standard Python tooling stack.  The application code lives in the `app` package.  A `Makefile` defines common developer tasks such as running the server locally, formatting and linting the codebase and executing tests.  A `pyproject.toml` configures our linters and test runner.  The Dockerfile and `render.yaml` file describe how the service is containerised and deployed on Render.

### Prerequisites

- Python 3.11 or later
- [ffmpeg/ffprobe](https://ffmpeg.org/) installed on your system (required to probe video durations)

### Install dependencies

```bash
pip install -r requirements.txt
```

### Development server

Run the application locally with hot reload:

```bash
make dev
```

Then open your browser at [http://localhost:8000](http://localhost:8000).  The UI will guide you through uploading a video, selecting a provider, choosing any extras and completing the payment step.  Behind the scenes the server creates a job, probes the video size and duration, determines the appropriate pricing tier and begins processing after checkout.  The live stepper updates via SSE and a download link appears once the job is complete.

### Testing

Unit and integration tests live in the `tests` directory.  Use the following command to run them and see coverage information:

```bash
make test
```

### Code quality

We enforce consistent formatting and linting using Black and Ruff.  To automatically format the codebase and fix simple issues run:

```bash
make fmt
```

To run the linter in check‑only mode:

```bash
make lint
```

### Building the container

To build a local Docker image for the application use:

```bash
make build
```

## Deployment

The service is configured to run on [Render](https://render.com/).  The `render.yaml` file defines a single web service which builds the image using the provided `Dockerfile`, serves HTTP requests and performs a health check on `/healthz`.  When pushing changes to the `main` branch the accompanying CI workflow runs tests and (optionally) triggers a deployment via the Render API.

### Environment variables

The application reads a number of environment variables to configure optional features:

| Variable                | Description                                                     |
|-------------------------|-----------------------------------------------------------------|
| `STRIPE_SECRET_KEY`     | Secret key used for creating Stripe Checkout sessions           |
| `STRIPE_WEBHOOK_SECRET` | Webhook secret used to verify Stripe events                    |
| `CLOUDCONVERT_API_KEY`  | API key for CloudConvert; if unset, a local copy is performed  |
| `MAILGUN_API_KEY`       | API key for Mailgun; if set, Mailgun is used to send emails    |
| `MAILGUN_DOMAIN`        | Domain configured in Mailgun (e.g. `mg.example.com`)           |
| `EMAIL_SMTP_HOST`       | Hostname of the SMTP server for sending emails (fallback)       |
| `EMAIL_SMTP_PORT`       | Port of the SMTP server (fallback)                             |
| `EMAIL_USERNAME`        | Username for SMTP authentication (fallback)                    |
| `EMAIL_PASSWORD`        | Password for SMTP authentication (fallback)                    |
| `SENDER_EMAIL`          | From address for outgoing emails (e.g. `contact@mailsized.com`)|
| `DOWNLOAD_TTL_MIN`      | Minutes before a generated download link expires (default 30)   |
| `ENABLE_ADSENSE`        | Set to `true` to activate AdSense; `false` disables ads         |
| `ADSENSE_CLIENT_ID`     | Your Google AdSense client ID (e.g. `ca-pub-…`)                 |
| `CONSENT_GIVEN`         | Indicates whether the user has consented to ad loading         |

If the AdSense flags are not all set the ad placeholders remain empty and do not shift the layout.

## License

This project is licensed under the MIT License.  See the [LICENSE](LICENSE) file for details.
