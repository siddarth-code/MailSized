import asyncio
import json
import urllib.parse

import pytest
from httpx import AsyncClient, ASGITransport

from app import main as app_module


@pytest.mark.asyncio
async def test_full_happy_flow(monkeypatch):
    monkeypatch.setenv("DOWNLOAD_TTL_MIN", "0.01")
    monkeypatch.setattr(app_module, "DOWNLOAD_TTL_MIN", 0.01, raising=False)

    async def fake_send_email(to, url):
        pass
    monkeypatch.setattr(app_module, "send_email", fake_send_email)

    async def fake_run_job(job):
        job.status = app_module.JobStatus.RUNNING
        app_module.put(job, type="progress", progress=50, status=app_module.JobStatus.RUNNING, message="Halfway")
        out_path = app_module.OUTPUT_DIR / f"{job.job_id}.mp4"
        out_path.write_bytes(b"compressed")
        job.out_path = out_path
        job.status = app_module.JobStatus.DONE
        app_module.put(job, type="state", status=app_module.JobStatus.DONE, progress=100, message="Complete", download_url=f"{app_module.PUBLIC_BASE_URL}/media/{out_path.name}")
        asyncio.create_task(app_module._schedule_cleanup(job.job_id))

    monkeypatch.setattr(app_module, "run_job", fake_run_job)
    monkeypatch.setattr(app_module, "probe_info", lambda path: (10.0, 0, 0))

    transport = ASGITransport(app=app_module.app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        file_bytes = b"x" * 1024
        resp = await client.post("/upload", files={"file": ("sample.mp4", file_bytes, "video/mp4")})
        assert resp.status_code == 200
        upload_id = resp.json()["upload_id"]

        payload = {
            "upload_id": upload_id,
            "provider": "gmail",
            "priority": False,
            "transcript": False,
            "email": "user@example.com",
        }
        resp2 = await client.post("/checkout", json=payload)
        assert resp2.status_code == 200
        url = resp2.json()["url"]
        job_id = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["job_id"][0]

        statuses = []
        download_url = None
        async with client.stream("GET", f"/events/{job_id}") as stream:
            async for line in stream.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = json.loads(line[5:])
                statuses.append(payload["status"])
                if payload.get("download_url"):
                    download_url = payload["download_url"]
                    break
        assert download_url
        assert app_module.JobStatus.DONE in statuses

        dl_resp = await client.get(download_url)
        assert dl_resp.status_code == 200
        assert dl_resp.content == b"compressed"

        await asyncio.sleep(1)
        assert job_id not in app_module.JOBS

