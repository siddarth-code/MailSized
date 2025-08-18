from app.main import email_target_bitrates, auto_scale


def test_email_target_bitrates_extremes():
    v_high, cap_high = email_target_bitrates(10 * 3600, 5 * 1024 * 1024 * 1024)
    assert v_high > 0
    assert cap_high == 1280

    v_low, cap_low = email_target_bitrates(0, 100_000)
    assert v_low >= 120
    assert cap_low == 854


def test_auto_scale_extremes():
    assert auto_scale(0, 0, 400_000) == (960, 540)
    assert auto_scale(4000, 3000, 1_000_000) == (1920, 1080)
