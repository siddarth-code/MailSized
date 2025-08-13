#!/usr/bin/env bash
set -euo pipefail

mkdir -p temp_uploads bin

echo "Downloading static FFmpeg..."
curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -o /tmp/ffmpeg.tar.xz
tar -C /tmp -xJf /tmp/ffmpeg.tar.xz
FFDIR="$(find /tmp -maxdepth 1 -type d -name 'ffmpeg-*-amd64-static' | head -n1)"
cp "$FFDIR/ffmpeg" "$FFDIR/ffprobe" ./bin/
chmod +x ./bin/ffmpeg ./bin/ffprobe
echo "Static FFmpeg installed to ./bin"

pip install --upgrade pip
pip install -r requirements.txt
