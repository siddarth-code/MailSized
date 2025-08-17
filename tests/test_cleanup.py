import os
import tempfile
from pathlib import Path

import pytest

from app import main as app_module


@pytest.mark.asyncio
async def test_cleanup_job_removes_files():
    # Create temporary files for input and output
    fd_in, path_in = tempfile.mkstemp(suffix=".mp4")
    os.close(fd_in)
    with open(path_in, "wb") as f:
        f.write(b"input")
    fd_out, path_out = tempfile.mkstemp(suffix=".mp4")
    os.close(fd_out)
    with open(path_out, "wb") as f:
        f.write(b"output")

    upload = app_module.UploadMeta(
        upload_id="u1",
        src_path=Path(path_in),
        size_bytes=len(b"input"),
        duration_sec=60,
        width=0,
        height=0,
    )
    job = app_module.JobState(
        job_id="cleanup-test",
        upload=upload,
        out_path=Path(path_out),
        status=app_module.JobStatus.DONE,
    )
    app_module.UPLOADS[upload.upload_id] = upload
    app_module.JOBS[job.job_id] = job

    # Run cleanup (should remove files and job)
    await app_module.cleanup_job(job.job_id)

    assert not os.path.exists(path_in)
    assert not os.path.exists(path_out)
    assert job.job_id not in app_module.JOBS
    assert upload.upload_id not in app_module.UPLOADS
