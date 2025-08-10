from app.main import PROVIDER_TARGETS_MB


def test_provider_target_mapping():
    assert PROVIDER_TARGETS_MB["gmail"] == 25
    assert PROVIDER_TARGETS_MB["outlook"] == 20
    assert PROVIDER_TARGETS_MB["other"] == 15