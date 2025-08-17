import pytest
from httpx import AsyncClient, ASGITransport

from app import main as app_module
from app.main import app


@pytest.mark.asyncio
async def test_upload_reject_unsupported_file_type():
    # Uploading a plain text file should return 400
    file_content = b"hello world"
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/upload",
            files={"file": ("test.txt", file_content, "text/plain")},
        )
        assert resp.status_code == 400


@pytest.mark.asyncio
async def test_upload_reject_large_file(monkeypatch):
    # Monkeypatch the MAX_SIZE_GB to a tiny value to force rejection
    monkeypatch.setattr(app_module, "MAX_SIZE_GB", 0.000001)
    file_content = b"x" * (2 * 1024 * 1024)  # 2MB
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/upload",
            files={"file": ("big.mp4", file_content, "video/mp4")},
        )
        assert resp.status_code == 400
        assert "2GB" in resp.json()["detail"] or "limit" in resp.json()["detail"].lower()


@pytest.mark.asyncio
async def test_upload_reject_long_video(monkeypatch):
    # Patch probe_duration to simulate a duration beyond the limit
    def fake_probe_info(_):
        return app_module.MAX_DURATION_SEC + 60, 0, 0  # exceed max by 1 minute

    monkeypatch.setattr(app_module, "probe_info", fake_probe_info)
    file_content = b"data" * 1024  # small file
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post(
            "/upload",
            files={"file": ("long.mp4", file_content, "video/mp4")},
        )
        assert resp.status_code == 400
        assert "20 minute" in resp.json()["detail"].lower()
