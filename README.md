# MailSized - Video Compression Service

Send large videos via email by compressing them to fit attachment limits.

## Features
- Compress videos up to 2GB
- Tiered pricing based on duration
- Priority processing option
- Secure file handling

## Deployment
Deployed on Render.com with the following configuration:
- Python 3.10.13
- FastAPI backend
- Persistent storage for uploads

## Requirements
See [requirements.txt](requirements.txt) for dependencies

## Setup
```bash
pip install -r requirements.txt
uvicorn main:app --reload