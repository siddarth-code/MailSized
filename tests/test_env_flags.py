import os
from app.main import _env_flag


def test_env_flag_truthy(monkeypatch):
    for val in ["1", "true", "TRUE", "yes", "on"]:
        monkeypatch.setenv("MYFLAG", val)
        assert _env_flag("MYFLAG") is True


def test_env_flag_falsey(monkeypatch):
    for val in ["0", "false", "no", "off", ""]:
        monkeypatch.setenv("MYFLAG", val)
        assert _env_flag("MYFLAG") is False
    monkeypatch.delenv("MYFLAG", raising=False)
    assert _env_flag("MYFLAG") is False
