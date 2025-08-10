import asyncio
from types import SimpleNamespace

import pytest

from app import main as app_module


@pytest.mark.asyncio
async def test_send_email_sets_headers(monkeypatch):
    # Prepare environment variables for SMTP
    monkeypatch.setenv("EMAIL_SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("EMAIL_SMTP_PORT", "587")
    monkeypatch.setenv("EMAIL_USERNAME", "user")
    monkeypatch.setenv("EMAIL_PASSWORD", "pass")
    monkeypatch.setenv("SENDER_EMAIL", "contact@mailsized.com")

    recorded = {}

    class DummySMTP:
        def __init__(self, host, port):
            # store host and port for assertions if needed
            self.host = host
            self.port = port

        def starttls(self):
            pass

        def login(self, user, password):
            pass

        def send_message(self, message):
            # Capture the message for inspection
            recorded['message'] = message

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(app_module, "smtplib", SimpleNamespace(SMTP=DummySMTP))

    await app_module.send_email("recipient@example.com", "http://download")

    # Ensure a message was recorded
    assert 'message' in recorded
    msg = recorded['message']
    assert msg["Auto-Submitted"] == "auto-generated"
    assert msg["X-Auto-Response-Suppress"] == "All"
    assert msg["Reply-To"] == "no-reply@mailsized.com"