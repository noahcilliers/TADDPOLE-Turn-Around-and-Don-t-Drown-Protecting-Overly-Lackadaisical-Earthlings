"""Pure analytics math for /v1/sensors/{id}/series and /stats (no I/O)."""
from __future__ import annotations

from datetime import datetime, timedelta

RANGES_S = {"1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600}
N_BUCKETS = 120


def parse_since(s: str, default_s: int = 24 * 3600) -> int:
    """'24h' / '90m' / '30s' / '3600' -> seconds."""
    if not s:
        return default_s
    s = s.strip().lower()
    mult = {"h": 3600, "m": 60, "s": 1, "d": 86400}.get(s[-1])
    try:
        return int(float(s[:-1]) * mult) if mult else int(float(s))
    except ValueError:
        return default_s


def series_window(end: datetime, range_key: str) -> tuple[datetime, int]:
    """Start time and bucket width (s) for exactly N_BUCKETS buckets ending at `end`."""
    total = RANGES_S[range_key]
    bucket_s = total // N_BUCKETS
    return end - timedelta(seconds=total), bucket_s


def bucket_max_readings(
    times: list[datetime], depths: list[float], start: datetime, bucket_s: int
) -> dict[int, float]:
    """idx -> max depth per bucket (index 0 = `start`); readings before `start` are skipped.

    Feed it spike-filtered depths: max of raw readings turns a single bad echo into the peak.
    """
    out: dict[int, float] = {}
    for t, d in zip(times, depths):
        idx = int((t - start).total_seconds() // bucket_s)
        if idx >= 0 and (idx not in out or d > out[idx]):
            out[idx] = d
    return out


def fill_buckets(idx_max: dict[int, float], start: datetime, bucket_s: int, n: int = N_BUCKETS) -> list[dict]:
    """idx -> max depth  ==>  n points; missing buckets are gaps (null)."""
    out = []
    for i in range(n):
        v = idx_max.get(i)
        out.append({
            "t": (start + timedelta(seconds=i * bucket_s)).isoformat(),
            "depth_cm": None if v is None else round(float(v), 1),
        })
    return out


def stats_from_minutes(
    minute_max: list[float | None], start: datetime, caution_cm: float, flooded_cm: float
) -> dict:
    """Stats over 1-minute max buckets (index 0 = `start`).

    fastest rise = max over the range of (b[i] - b[i-5]) / 5, both ends present.
    """
    peak, peak_i = None, None
    for i, v in enumerate(minute_max):
        if v is not None and (peak is None or v > peak):
            peak, peak_i = v, i
    fastest = None
    for i in range(5, len(minute_max)):
        a, b = minute_max[i - 5], minute_max[i]
        if a is not None and b is not None:
            r = (b - a) / 5.0
            if fastest is None or r > fastest:
                fastest = r
    present = [v for v in minute_max if v is not None]
    return {
        "peak_cm": None if peak is None else round(float(peak), 1),
        "peak_at": None if peak_i is None else (start + timedelta(minutes=peak_i)).isoformat(),
        "fastest_rise_cm_per_min": None if fastest is None else round(fastest, 2),
        "minutes_above_caution": sum(1 for v in present if v >= caution_cm) if present else None,
        "minutes_flooded": sum(1 for v in present if v >= flooded_cm) if present else None,
    }
