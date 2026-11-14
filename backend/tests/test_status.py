import pytest

from app.status import Status, classify, describe_depth, smoothed_depth

T = dict(caution_cm=5, flooded_cm=15, rise_rate_cm_per_min=2, hysteresis_cm=2)


@pytest.mark.parametrize("depth,expected", [(0, Status.CLEAR), (4.9, Status.CLEAR), (5, Status.CAUTION),
                                            (14.9, Status.CAUTION), (15, Status.FLOODED), (80, Status.FLOODED)])
def test_thresholds_from_clear(depth, expected):
    assert classify(Status.CLEAR, depth, 0, **T) is expected


def test_fast_rise_triggers_caution_even_when_shallow():
    assert classify(Status.CLEAR, 1.0, 2.5, **T) is Status.CAUTION


def test_hysteresis_holds_flooded_then_releases():
    assert classify(Status.FLOODED, 13.5, 0, **T) is Status.FLOODED
    assert classify(Status.FLOODED, 12.9, 0, **T) is Status.CAUTION


def test_hysteresis_holds_caution_then_clears():
    assert classify(Status.CAUTION, 3.5, 0, **T) is Status.CAUTION
    assert classify(Status.CAUTION, 2.9, 0, **T) is Status.CLEAR
    assert classify(Status.FLOODED, 2.0, 0, **T) is Status.CLEAR


def test_no_data_holds_previous():
    assert classify(Status.FLOODED, None, None, **T) is Status.FLOODED


def test_median_kills_single_spike():
    assert smoothed_depth([40.0, 1.0, 1.2], 3) == 1.2
    assert smoothed_depth([], 3) is None


def test_describe_depth():
    assert describe_depth(61) == "about 2 ft deep"
    assert describe_depth(10) == "about 4 in deep"
    assert describe_depth(0) == "shallow so far"


def test_rise_rate_net_change():
    from datetime import datetime, timedelta, timezone
    from app.status import rise_rate
    t0 = datetime(2026, 11, 14, tzinfo=timezone.utc)
    assert rise_rate(6.0, t0 + timedelta(seconds=60), 2.0, t0) == 4.0     # +4 cm in a minute
    assert rise_rate(0.0, t0 + timedelta(seconds=30), 20.0, t0) == -40.0  # draining -> negative
    assert rise_rate(6.0, t0 + timedelta(seconds=2), 2.0, t0) is None     # too little time to tell
    assert rise_rate(None, t0, 2.0, t0) is None
