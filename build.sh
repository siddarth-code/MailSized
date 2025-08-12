#!/usr/bin/env bash
set -euo pipefail

# Clean temp between deploys so you don't hit the 5GB quota
rm -rf temp_uploads/* || true
mkdir -p temp_uploads

# Install ffmpeg (Debian base image on Render supports apt)
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg
apt-get clean
rm -rf /var/lib/apt/lists/*

# Install Python deps into the venv Render set up
pip install --upgrade pip
pip install -r requirements.txt
