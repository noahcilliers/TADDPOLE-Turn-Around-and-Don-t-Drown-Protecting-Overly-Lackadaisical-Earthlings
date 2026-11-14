"""Spike filtering for raw depth readings. Pure functions, no I/O.

Ultrasonic sensors throw two kinds of single-sample garbage:
  * a stray close echo (splash, insect, rain) -> distance too short -> depth spikes UP
  * a missed echo / out-of-range             -> distance too long  -> depth drops to 0
Both last one or two samples. Real water moves smoothly by comparison.

`hampel` is a Hampel filter: for each reading, look at its neighbours, and if it is far
from their median (measured in robust standard deviations, via the MAD) replace it with
that median. Unlike a plain moving average it leaves genuine readings untouched, so the
shape and peak of a real flood survive; only outliers are rewritten.
"""
from __future__ import annotations

from statistics import median

MAD_TO_SIGMA = 1.4826  # MAD * this ~= standard deviation for normally distributed noise


def hampel(
    values: list[float],
    half_window: int = 3,
    n_sigmas: float = 3.0,
    min_dev: float = 1.0,
) -> list[float]:
    """Return a copy of `values` (oldest first) with spikes replaced by the local median.

    half_window: neighbours on each side (window = 2*half_window + 1 readings). It must be
                 more than twice the longest spike you want to remove (3 -> up to 3 in a row).
    n_sigmas:    how many robust std-devs from the median counts as a spike.
    min_dev:     floor on the threshold (cm). On calm water the MAD is ~0, and without a
                 floor every 2 mm wobble would be "an outlier".
    Edges use a truncated window, so the newest reading is judged against older ones only.
    """
    n = len(values)
    if n < 3 or half_window < 1:
        return list(values)
    out = list(values)
    for i in range(n):
        lo, hi = max(0, i - half_window), min(n, i + half_window + 1)
        win = values[lo:hi]
        med = median(win)
        mad = median(abs(v - med) for v in win)
        if abs(values[i] - med) > max(n_sigmas * MAD_TO_SIGMA * mad, min_dev):
            out[i] = med
    return out
