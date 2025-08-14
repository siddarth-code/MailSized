#!/usr/bin/env bash
set -euo pipefail

echo "==> Ensuring required folders exist"
mkdir -p ./bin
mkdir -p ./app/static
mkdir -p ./app/templates
mkdir -p ./temp_uploads

echo "==> Downloading static FFmpeg (if missing)"
if [ ! -x "./bin/ffmpeg" ] || [ ! -x "./bin/ffprobe" ]; then
  cd /tmp
  curl -L -o ffmpeg.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
  tar -xf ffmpeg.tar.xz
  FFDIR=$(find . -maxdepth 1 -type d -name "ffmpeg-*-amd64-static" | head -n 1)
  cp "$FFDIR/ffmpeg" "$FFDIR/ffprobe" /opt/render/project/src/bin/ 2>/dev/null || true
  cp "$FFDIR/ffmpeg" "$FFDIR/ffprobe" "$OLDPWD/bin/"
  cd "$OLDPWD"
fi

chmod +x ./bin/ffmpeg ./bin/ffprobe || true
echo "FFmpeg installed to ./bin"

echo "==> Upgrading pip to latest"
python -m pip install --upgrade pip

echo "==> Installing Python dependencies"
pip install -r requirements.txt

echo "==> Build complete"
