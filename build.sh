#!/bin/bash

# Debugging: Show current directory and files
echo "=== Current directory ==="
pwd
echo "=== Files in directory ==="
ls -la

set -e
# Cleanup old temp uploads before each build
rm -rf temp_uploads/* || true

# Install ffmpeg/ffprobe
apt-get update && apt-get install -y --no-install-recommends ffmpeg

# Continue with normal Python build
pip install --upgrade pip
pip install -r requirements.txt

# Install dependencies
echo "=== Installing dependencies ==="
pip install -r requirements.txt

# Show installed packages
echo "=== Installed packages ==="
pip freeze

# Create temp_uploads directory if needed
mkdir -p temp_uploads
