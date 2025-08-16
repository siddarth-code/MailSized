from app.main import PROVIDER_TARGETS_MB, choose_target


def test_provider_target_mapping():
    assert PROVIDER_TARGETS_MB["gmail"] == 25
    assert PROVIDER_TARGETS_MB["outlook"] == 20
    assert PROVIDER_TARGETS_MB["other"] == 15


def test_choose_target_respects_original_size():
    small = 5 * 1024 * 1024  # 5MB
    assert choose_target("gmail", small) == small


def test_choose_target_case_insensitive():
    large = 30 * 1024 * 1024  # 30MB, above Gmail cap
    expected = int((25 - 1.5) * 1024 * 1024)
    assert choose_target("Gmail", large) == expected

