from app.main import compute_order_total_cents


def test_pricing_gmail_tier1():
    size_bytes = 400 * 1024 * 1024  # 400MB
    cents = compute_order_total_cents("gmail", size_bytes, False, False)
    assert cents == 219  # $1.99 + 10%


def test_pricing_with_upsells():
    size_bytes = 600 * 1024 * 1024  # tier2
    cents = compute_order_total_cents("other", size_bytes, True, True)
    # base 3.99 +0.75+1.50=6.24; +10% = 6.864 -> 686 cents
    assert cents == 686
