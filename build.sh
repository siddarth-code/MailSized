#!/usr/bin/env bash
set -euo pipefail

# Ensure folders exist
mkdir -p temp_uploads bin

# ---- Get a static ffmpeg/ffprobe ----
# We use the well-known johnvansickle.com static build.
# If this URL ever changes, you can swap to BtbN builds from GitHub.
echo "Downloading static FFmpeg..."
curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ffmpeg.tar.xz
tar -C /tmp -xJf /tmp/ffmpeg.tar.xz
FFDIR="$(find /tmp -maxdepth 1 -type d -name 'ffmpeg-*-amd64-static' | head -n1)"
cp "$FFDIR/ffmpeg" "$FFDIR/ffprobe" ./bin/
chmod +x ./bin/ffmpeg ./bin/ffprobe
echo "Static FFmpeg installed to ./bin"

# ---- Python deps ----
pip install --upgrade pip
pip install -r requirements.txt

# (Optional) keep the temp dir clean between builds
rm -rf temp_uploads/* 2>/dev/null || true
