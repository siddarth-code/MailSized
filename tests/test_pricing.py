import pytest

from app.main import calculate_pricing


def test_tier1_by_duration_and_size():
    # Video of 4 minutes and 50 MB should be tier 1
    result = calculate_pricing(4 * 60, 50 * 1024 * 1024)
    assert result["tier"] == 1
    assert result["price"] == 1.99
    assert result["max_length_min"] == 5
    assert result["max_size_mb"] == 100


def test_tier1_by_size_smaller_dimension():
    # Duration of 9 minutes but only 50 MB → size is the limiting factor → tier 1
    result = calculate_pricing(9 * 60, 50 * 1024 * 1024)
    assert result["tier"] == 1
    assert result["price"] == 1.99


def test_tier2():
    # 8 minutes and 150 MB fits tier 2
    result = calculate_pricing(8 * 60, 150 * 1024 * 1024)
    assert result["tier"] == 2
    assert result["price"] == 2.99


def test_tier3():
    # 18 minutes and 350 MB fits tier 3
    result = calculate_pricing(18 * 60, 350 * 1024 * 1024)
    assert result["tier"] == 3
    assert result["price"] == 4.99


def test_out_of_bounds_raises():
    # 25 minutes or 450 MB should raise ValueError
    with pytest.raises(ValueError):
        calculate_pricing(25 * 60, 100 * 1024 * 1024)
    with pytest.raises(ValueError):
        calculate_pricing(10 * 60, 450 * 1024 * 1024)