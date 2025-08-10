import asyncio
import os
import tempfile

import pytest

from datetime import datetime, timedelta

from app import main as app_module


@pytest.mark.asyncio
async def test_cleanup_job_removes_files(monkeypatch):
    # Create temporary files for input and output
    fd_in, path_in = tempfile.mkstemp(suffix=".mp4")
    os.close(fd_in)
    with open(path_in, "wb") as f:
        f.write(b"input")
    fd_out, path_out = tempfile.mkstemp(suffix=".mp4")
    os.close(fd_out)
    with open(path_out, "wb") as f:
        f.write(b"output")

    # Create a dummy job
    job_id = "cleanup-test"
    pricing = {"tier": 1, "price": 1.99, "max_length_min": 5, "max_size_mb": 100}
    job = app_module.Job(job_id, path_in, 60, len(b"input"), pricing)
    job.output_path = path_out
    job.download_expiry = datetime.utcnow() + timedelta(seconds=0)
    app_module.jobs[job_id] = job

    # Run cleanup (should remove files and job)
    await app_module.cleanup_job(job_id)

    assert not os.path.exists(path_in)
    assert not os.path.exists(path_out)
    assert job_id not in app_module.jobs