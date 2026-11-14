"""Turn-by-turn steps from a routed path (pure)."""
from __future__ import annotations

import math
from dataclasses import dataclass

CARDINALS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]


@dataclass
class Leg:
    name: str
    length_m: float
    bearing_start: float   # degrees, 0 = north, clockwise
    bearing_end: float


def road_name(raw) -> str:
    if isinstance(raw, (list, tuple)):
        raw = next((x for x in raw if x), None)
    if isinstance(raw, str) and raw.startswith("[") and raw.endswith("]"):  # graphml-stringified list
        inner = [x.strip(" '\"") for x in raw[1:-1].split(",")]
        raw = next((x for x in inner if x), None)
    return raw if isinstance(raw, str) and raw.strip() else "unnamed road"


def bearing(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def cardinal(b: float) -> str:
    return CARDINALS[int(((b % 360) + 22.5) // 45) % 8]


def turn_phrase(delta: float) -> str:
    """delta = new bearing - old bearing, normalised to (-180, 180]."""
    a = abs(delta)
    side = "right" if delta > 0 else "left"
    if a < 25:
        return "Continue onto"
    if a < 60:
        return f"Bear {side} onto"
    if a < 150:
        return f"Turn {side} onto"
    return "Make a U-turn onto"


def norm_delta(new: float, old: float) -> float:
    d = (new - old + 180) % 360 - 180
    return 180.0 if d == -180 else d


def build_steps(legs: list[Leg]) -> list[dict]:
    """Group consecutive legs on the same road; one instruction per road change."""
    groups: list[dict] = []
    for leg in legs:
        if groups and groups[-1]["road"] == leg.name:
            g = groups[-1]
            g["distance_m"] += leg.length_m
            g["bearing_end"] = leg.bearing_end
        else:
            groups.append({"road": leg.name, "distance_m": leg.length_m,
                           "bearing_start": leg.bearing_start, "bearing_end": leg.bearing_end})
    steps = []
    for i, g in enumerate(groups):
        if i == 0:
            instr = f"Head {cardinal(g['bearing_start'])} on {g['road']}"
        else:
            instr = f"{turn_phrase(norm_delta(g['bearing_start'], groups[i - 1]['bearing_end']))} {g['road']}"
        steps.append({"instruction": instr, "road": g["road"], "distance_m": round(g["distance_m"])})
    return steps
