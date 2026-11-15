"""POST /v1/routes: fastest route + (if it's unsafe) a safer one, annotated per API_V1.md."""
from __future__ import annotations

from .routing import NoRoute, RoadNetwork, Route
from .steps import build_steps


def _route_obj(net: RoadNetwork, r: Route, rid: str, kind: str, sensors: dict[str, dict],
               unsafe_ids: set[str], hazard_edges: set) -> dict:
    """sensors: id -> {name, status, depth_cm}"""
    crosses = []
    for sid in r.sensors_on_route:
        s = sensors.get(sid)
        if s is None:
            continue
        crosses.append({
            "sensor_id": sid, "name": s["name"], "status": s["status"], "depth_cm": s["depth_cm"],
            "at_distance_m": round(net.at_distance(r, net.core_edges(sid)) or 0),
        })
    crosses.sort(key=lambda c: c["at_distance_m"])
    safe = not any(c["sensor_id"] in unsafe_ids for c in crosses) and not (r.edges & hazard_edges)
    return {
        "id": rid, "kind": kind,
        "duration_s": round(r.duration_s), "distance_m": round(r.distance_m),
        "safe": safe,
        "geometry": {"type": "LineString", "coordinates": r.coords},
        "crosses": crosses,
        "steps": build_steps(net.legs_for_steps(r)),
    }


def build_routes(
    net: RoadNetwork,
    orig_lnglat: tuple[float, float],
    dest_lnglat: tuple[float, float],
    sensors: dict[str, dict],
    *,
    avoid_offline: bool = True,
    hazard_sensor_ids: set[str] = frozenset(),
    hazard_edges: set = frozenset(),
) -> dict:
    """Raises NoRoute only if the endpoints aren't connected at all."""
    orig = (orig_lnglat[1], orig_lnglat[0])
    dest = (dest_lnglat[1], dest_lnglat[0])
    unsafe = {sid for sid, s in sensors.items()
              if s["status"] == "flooded" or (avoid_offline and s["status"] == "offline")}
    unsafe |= set(hazard_sensor_ids)
    hazard_edges = set(hazard_edges)

    fastest = net.route(orig, dest)                      # ignores floods entirely
    f = _route_obj(net, fastest, "r_fast", "fastest", sensors, unsafe, hazard_edges)
    if not unsafe and not hazard_edges:
        return {"recommended": "r_fast", "routes": [f]}
    # Something is flooded/offline somewhere: plan the preferred route with the closed zones
    # removed, a cost buffer around them, and a nudge toward stretches sensors say are dry.
    # Even a "safe" fastest route can skim the edge of a flood, so compare rather than assume.
    mult = net.status_multipliers({sid: s["status"] for sid, s in sensors.items()}, unsafe)
    try:
        safer = net.route(orig, dest, frozenset(unsafe), extra_blocked=hazard_edges, multipliers=mult)
    except NoRoute:
        return {"recommended": "r_fast", "routes": [f]}
    if safer.path == fastest.path:
        return {"recommended": "r_fast", "routes": [f]}
    s = _route_obj(net, safer, "r_safer", "safer", sensors, unsafe, hazard_edges)
    s["delta_vs_fastest_s"] = s["duration_s"] - f["duration_s"]
    return {"recommended": "r_safer", "routes": [f, s]}
