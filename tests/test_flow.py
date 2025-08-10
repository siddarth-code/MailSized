import asyncio
import json
from pathlib import Path

import pytest
from httpx import AsyncClient

from app import main as app_module


@pytest.mark.asyncio
async def test_full_happy_flow(monkeypatch, tmp_path):
    """End‑to‑end test of upload → checkout → compression → download."""
    # Use a very short TTL so cleanup happens quickly
    monkeypatch.setenv("DOWNLOAD_TTL_MIN", "0.01")  # ~0.6 seconds

    # Patch compress_video to avoid heavy processing
    async def fake_compress(file_path: str, output_path: str, target_size_mb: int) -> None:
        # Write a tiny dummy output file
        Path(output_path).write_bytes(b"compressed")

    # Patch send_email to no‑op
    async def fake_send_email(recipient: str, download_url: str) -> None:
        pass

    monkeypatch.setattr(app_module, "compress_video", fake_compress)
    monkeypatch.setattr(app_module, "send_email", fake_send_email)

    async with AsyncClient(app=app_module.app, base_url="http://test") as client:
        # Upload a small video file
        file_bytes = b"\x00" * 1024  # 1KB dummy video
        resp = await client.post(
            "/upload",
            files={"file": ("sample.mp4", file_bytes, "video/mp4")},
        )
        assert resp.status_code == 200
        data = resp.json()
        job_id = data["job_id"]

        # Checkout request
        form = {
            "job_id": job_id,
            "provider": "gmail",
            "priority": "false",
            "transcript": "false",
            "email": "",
        }
        resp2 = await client.post("/checkout", data=form)
        assert resp2.status_code == 200
        assert resp2.json()["status"] == "queued"

        # Consume SSE events until done
        statuses = []
        download_url = None
        async with client.stream("GET", f"/events/{job_id}") as stream:
            async for line in stream.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = json.loads(line[5:])
                statuses.append(payload["status"])
                if payload["status"] == app_module.JobStatus.DONE:
                    download_url = payload.get("download_url")
                    break
        assert download_url
        assert app_module.JobStatus.DONE in statuses

        # Download the compressed file
        download_resp = await client.get(download_url)
        assert download_resp.status_code == 200
        assert download_resp.content == b"compressed"

        # Allow cleanup to run
        await asyncio.sleep(1)
        # The job should be gone from registry
        assert job_id not in app_module.jobs