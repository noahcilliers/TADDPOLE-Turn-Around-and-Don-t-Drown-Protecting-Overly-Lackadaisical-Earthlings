"""Pure flood-status logic. No I/O, so it is trivially unit-testable."""
from datetime import datetime
from enum import Enum
from statistics import median


class Status(str, Enum):
    CLEAR = "clear"
    CAUTION = "caution"
    FLOODED = "flooded"
    OFFLINE = "offline"   # no reading for OFFLINE_AFTER_S; overrides the depth-based status


RISK_ORDER = {"flooded": 0, "caution": 1, "offline": 2, "clear": 3}


def smoothed_depth(recent_depths: list[float] | None, n: int) -> float | None:
    """Median of the most recent `n` depths (list is newest-first)."""
    if not recent_depths:
        return None
    return float(median(recent_depths[:n]))


def rise_rate(
    current_depth: float | None,
    current_time: datetime | None,
    start_depth: float | None,
    start_time: datetime | None,
    min_elapsed_s: float = 5.0,
) -> float | None:
    """Net change (cm/min) from the start of the window to the smoothed current depth."""
    if None in (current_depth, current_time, start_depth, start_time):
        return None
    elapsed = (current_time - start_time).total_seconds()
    if elapsed < min_elapsed_s:
        return None
    return (current_depth - start_depth) / (elapsed / 60.0)


def classify(
    prev: Status,
    depth_cm: float | None,
    rise_cm_per_min: float | None,
    *,
    caution_cm: float,
    flooded_cm: float,
    rise_rate_cm_per_min: float,
    hysteresis_cm: float,
) -> Status:
    """Next status given the smoothed depth, its rise rate and the previous status.

    Hysteresis: once at a level, depth must fall `hysteresis_cm` below that
    level's threshold before we downgrade, so a reading hovering at 15 cm does
    not flap the road open/closed every second.
    """
    if depth_cm is None:
        return prev  # no data: hold the last known state (safer than clearing)

    if depth_cm >= flooded_cm:
        return Status.FLOODED
    if prev is Status.FLOODED and depth_cm >= flooded_cm - hysteresis_cm:
        return Status.FLOODED

    rising_fast = rise_cm_per_min is not None and rise_cm_per_min >= rise_rate_cm_per_min
    if depth_cm >= caution_cm or rising_fast:
        return Status.CAUTION
    if prev in (Status.CAUTION, Status.FLOODED) and depth_cm >= caution_cm - hysteresis_cm:
        return Status.CAUTION

    return Status.CLEAR


def describe_depth(depth_cm: float | None) -> str:
    """Human depth for alerts: 'about 2 ft deep', 'about 4 in deep'."""
    if depth_cm is None:
        return "depth unknown"
    inches = depth_cm / 2.54
    if inches < 0.5:
        return "shallow so far"
    if inches >= 12:
        feet = round(inches / 12 * 2) / 2  # nearest half foot
        return f"about {feet:g} ft deep"
    return f"about {max(1, round(inches))} in deep"
