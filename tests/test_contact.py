import pytest
from fastapi.testclient import TestClient
from app import main as app_module


def test_contact_post_uses_background_tasks(monkeypatch):
    recorded = {}

    def fake_send(email, subject, message):
        recorded['args'] = (email, subject, message)

    monkeypatch.setattr(app_module, 'send_contact_message', fake_send)
    client = TestClient(app_module.app)
    resp = client.post(
        '/contact',
        data={'user_email': 'user@example.com', 'subject': 'Sub', 'message': 'Body'},
        allow_redirects=False,
    )
    assert resp.status_code == 303
    assert recorded['args'] == (
        'user@example.com',
        'Sub',
        'Body'
    )
