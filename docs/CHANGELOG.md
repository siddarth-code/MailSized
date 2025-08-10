# Changelog

All notable changes to this project will be documented in this file.  The format is based on [Keep a Changelog](https://keepachangelog.com/) and this project adheres to [Semantic Versioning](https://semver.org/).

## [v1.0.0] - 2025-08-10

### Added

- Initial public release of **MailSized**.
- FastAPI backend with endpoints for uploading videos, performing a checkout, streaming job status via Server‑Sent Events, downloading the compressed result and a health check.
- Jinja2/HTML frontend implementing a four‑step wizard (Upload → Payment → Compression → Download) with live pricing updates, provider selection, optional upsells and AdSense placeholders (disabled by default).
- Tiered pricing logic calculating the smallest tier based on either duration or size (three levels).
- Temporary storage of uploads and outputs with configurable TTL (default 30 minutes) and automatic cleanup of expired jobs.
- Email notifications with proper no‑reply headers and parallel dispatch once compression completes.
- Comprehensive unit and integration tests covering pricing tiers, validation logic, email headers, cleanup behaviour, provider target mapping and a full happy‑path flow.
- Development tooling: `pyproject.toml` for formatting and linting (Black/Ruff), a `Makefile` with convenience targets and a GitHub Actions workflow for CI.
- Containerisation via a `Dockerfile` and `render.yaml` for deployment on Render, including environment variable definitions and health checks.
