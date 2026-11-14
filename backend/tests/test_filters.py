from datetime import datetime, timedelta, timezone

from app.analytics import bucket_max_readings
from app.filters import hampel


def test_single_up_spike_removed():
    clean = hampel([10.0, 10.1, 10.0, 45.0, 10.2, 10.1, 10.0])
    assert clean[3] == 10.1
    assert clean[:3] + clean[4:] == [10.0, 10.1, 10.0, 10.2, 10.1, 10.0]


def test_dropout_to_zero_removed():
    clean = hampel([12.0, 12.2, 12.1, 0.0, 12.3, 12.2, 12.4])
    assert 12.0 <= clean[3] <= 12.4


def test_two_in_a_row_removed():
    clean = hampel([5.0, 5.1, 5.0, 30.0, 31.0, 5.2, 5.1, 5.0, 5.1])
    assert max(clean) < 6


def test_real_rise_and_peak_preserved():
    ramp = [float(i) for i in range(30)]  # steady 1 cm/reading rise
    assert hampel(ramp) == ramp
    step = [2.0] * 8 + [20.0] * 8         # sudden but sustained jump (water arrives)
    assert hampel(step) == step


def test_small_noise_untouched_on_calm_water():
    vals = [10.0, 10.2, 9.9, 10.1, 10.0, 10.3, 9.8]
    assert hampel(vals) == vals


def test_short_input_passthrough():
    assert hampel([]) == []
    assert hampel([1.0, 50.0]) == [1.0, 50.0]


def test_bucket_max_skips_pad_and_groups():
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    times = [start + timedelta(seconds=s) for s in (-30, 0, 10, 35, 59, 61)]
    depths = [99.0, 1.0, 3.0, 2.0, 4.0, 7.0]
    assert bucket_max_readings(times, depths, start, 30) == {0: 3.0, 1: 4.0, 2: 7.0}
