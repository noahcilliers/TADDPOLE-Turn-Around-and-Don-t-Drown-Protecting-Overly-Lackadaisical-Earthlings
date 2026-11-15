"""/v1 API (contract: API_V1.md)."""
from __future__ import annotations

import asyncio
import hmac
import json
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from . import analytics, db, filters
from .routing import NoRoute
from .v1routes import build_routes

router = APIRouter(prefix="/v1")

DEMO = {
    "from": [-111.99532, 33.477532],
    "to": [-111.99532, 33.516655],
    "destination_name": "N 40th St & E Stanford Dr",
    "stall_lnglat": [-111.99532, 33.506947],
}


# ---------------- helpers ----------------
def S(request_or_ws):
    return request_or_ws.app.state


def require_admin(request: Request, x_admin_token: str = Header(default="")) -> None:
    token = request.app.state.cfg.admin_token
    if not token:
        raise HTTPException(404, "admin endpoints disabled (set ADMIN_TOKEN)")
    if not hmac.compare_digest(x_admin_token, token):
        raise HTTPException(401, "bad admin token")


def config_payload(state) -> dict:
    cfg = state.cfg
    net = state.hub.network
    return {
        "thresholds": {"caution_cm": cfg.caution_cm, "flooded_cm": cfg.flooded_cm},
        "offline_after_s": cfg.offline_after_s,
        "flood_zone_m": cfg.flood_block_radius_m,   # roads within this of a flooded sensor are closed
        "bounds": list(net.bounds) if net else None,
        "demo": {**DEMO, "sensor_id": cfg.demo_sensor_id},
    }


def parse_lnglat(s: str) -> tuple[float, float]:
    try:
        lng, lat = (float(x) for x in s.split(","))
    except Exception:
        raise HTTPException(422, f"expected 'lng,lat', got {s!r}")
    if not (-180 <= lng <= 180 and -90 <= lat <= 90):
        raise HTTPException(422, "lng/lat out of range")
    return lng, lat


def _sensor_or_404(state, sid: str) -> None:
    if sid not in state.poller.sensor_rows:
        raise HTTPException(404, "unknown sensor")


def _demo_filter(state) -> tuple[str, str]:
    return state.cfg.demo_sensor_id, state.poller.demo_source()


# Readings fetched before the window start so the spike filter has neighbours for the first points.
SPIKE_PAD_S = 120


async def _filtered_bucket_max(st, sensor_id: str, start: datetime, end: datetime, bucket_s: int) -> dict[int, float]:
    """Max depth per bucket after removing single-reading spikes (see app/filters.py)."""
    rows = await db.readings(st.pool, sensor_id, start - timedelta(seconds=SPIKE_PAD_S), end, *_demo_filter(st))
    times = [t for t, _ in rows]
    clean = filters.hampel(
        [d for _, d in rows],
        half_window=st.cfg.spike_half_window, n_sigmas=st.cfg.spike_sigmas, min_dev=st.cfg.spike_min_cm,
    )
    return analytics.bucket_max_readings(times, clean, start, bucket_s)


def _fmt_depth(d) -> str:
    if d is None:
        return ""
    return f"{round(d)} cm · {d / 2.54:.1f} in"


def event_payload(e: dict) -> dict:
    if e["kind"] == "status_change":
        if e["to_status"] == "offline":
            detail = "No reading from sensor"
        else:
            detail = _fmt_depth(e["depth_cm"])
        return {
            "id": f"sc_{e['sensor_id']}_{int(e['time'].timestamp() * 1000)}",
            "time": e["time"].isoformat(), "kind": "status_change",
            "sensor_id": e["sensor_id"], "title": e["title"],
            "from_status": e["from_status"], "to_status": e["to_status"],
            "depth_cm": None if e["depth_cm"] is None else round(e["depth_cm"], 1),
            "detail": detail,
        }
    detail = {"stalled_vehicle": "Car stalled in the water"}.get(e["hazard_kind"], e["hazard_kind"])
    if e["source"]:
        detail += {"driver": " · reported by a driver", "demo": " · demo report", "operator": " · operator"}.get(e["source"], "")
    return {
        "id": f"hz_{e['hazard_id']}", "time": e["time"].isoformat(), "kind": "hazard",
        "sensor_id": e["sensor_id"], "title": e["title"], "hazard_kind": e["hazard_kind"],
        "depth_cm": None, "detail": detail,
    }


# ---------------- REST ----------------
@router.get("/config")
async def v1_config(request: Request):
    return config_payload(S(request))


@router.get("/sensors")
async def v1_sensors(request: Request, near: str | None = None, sort: Literal["risk", "near"] = "risk"):
    nr = parse_lnglat(near) if near else None
    return S(request).poller.v1_sensors(near=nr, sort=sort)


@router.get("/sensors/{sensor_id}")
async def v1_sensor(request: Request, sensor_id: str):
    st = S(request)
    _sensor_or_404(st, sensor_id)
    return st.poller.v1_sensor(sensor_id)


@router.get("/sensors/{sensor_id}/series")
async def v1_series(request: Request, sensor_id: str,
                    rng: Literal["1h", "6h", "24h"] = Query("1h", alias="range")):
    st = S(request)
    _sensor_or_404(st, sensor_id)
    end = datetime.now(timezone.utc)
    start, bucket_s = analytics.series_window(end, rng)
    idx = await _filtered_bucket_max(st, sensor_id, start, end, bucket_s)
    return {"range": rng, "bucket_s": bucket_s, "points": analytics.fill_buckets(idx, start, bucket_s)}


@router.get("/sensors/{sensor_id}/stats")
async def v1_stats(request: Request, sensor_id: str,
                   rng: Literal["1h", "6h", "24h"] = Query("24h", alias="range")):
    st = S(request)
    _sensor_or_404(st, sensor_id)
    end = datetime.now(timezone.utc)
    total = analytics.RANGES_S[rng]
    start = end - timedelta(seconds=total)
    idx = await _filtered_bucket_max(st, sensor_id, start, end, 60)
    minutes = [idx.get(i) for i in range(total // 60)]
    return analytics.stats_from_minutes(minutes, start, st.cfg.caution_cm, st.cfg.flooded_cm)


@router.get("/sensors/{sensor_id}/status-changes")
async def v1_status_changes(request: Request, sensor_id: str, since: str = "24h", limit: int = Query(5, ge=1, le=100)):
    st = S(request)
    _sensor_or_404(st, sensor_id)
    rows = await db.status_changes(st.pool, sensor_id, analytics.parse_since(since), limit)
    return [{"time": r["time"].isoformat(), "from_status": r["from_status"], "to_status": r["to_status"],
             "depth_cm": None if r["depth_cm"] is None else round(r["depth_cm"], 1)} for r in rows]


@router.get("/events")
async def v1_events(request: Request, since: str = "2h", limit: int = Query(50, ge=1, le=500)):
    rows = await db.events_v1(S(request).pool, analytics.parse_since(since, 7200), limit)
    return [event_payload(e) for e in rows]


class RoutesReq(BaseModel):
    model_config = {"populate_by_name": True}
    from_: list[float] = Field(alias="from", min_length=2, max_length=2)
    to: list[float] = Field(min_length=2, max_length=2)
    avoid_offline: bool = True


@router.post("/routes")
async def v1_routes(request: Request, body: RoutesReq):
    st = S(request)
    net = st.hub.network
    if net is None:
        raise HTTPException(503, "routing unavailable")
    for lng, lat in (body.from_, body.to):
        if not net.contains(lat, lng):
            raise HTTPException(422, "point outside the mapped area")
    sensors = {sid: {"name": v["name"], "status": v["current"]["status"], "depth_cm": v["current"]["depth_cm"]}
               for sid, v in ((s["id"], s) for s in st.poller.v1_sensors())}
    hz_sensors, hz_edges = st.hazards.blocked()
    try:
        return await asyncio.to_thread(
            build_routes, net, tuple(body.from_), tuple(body.to), sensors,
            avoid_offline=body.avoid_offline, hazard_sensor_ids=hz_sensors, hazard_edges=hz_edges)
    except NoRoute:
        raise HTTPException(409, "destination not reachable")


class HazardReq(BaseModel):
    kind: Literal["stalled_vehicle", "road_closed", "debris"] = "stalled_vehicle"
    location: list[float] = Field(min_length=2, max_length=2)
    source: Literal["driver", "operator"] = "driver"


@router.post("/hazards", status_code=201)
async def v1_create_hazard(request: Request, body: HazardReq):
    lng, lat = body.location
    if not (-180 <= lng <= 180 and -90 <= lat <= 90):
        raise HTTPException(422, "lng/lat out of range")
    return await S(request).hazards.create(kind=body.kind, lon=lng, lat=lat, source=body.source)


@router.get("/hazards/active")
async def v1_active_hazards(request: Request):
    return S(request).hazards.payloads()


@router.delete("/hazards/{hazard_id}", status_code=204, dependencies=[Depends(require_admin)])
async def v1_delete_hazard(request: Request, hazard_id: str):
    if not await S(request).hazards.clear(hazard_id, "operator"):
        raise HTTPException(404, "no active hazard with that id")
    return Response(status_code=204)


# ---------------- demo ----------------
class DemoStart(BaseModel):
    mode: Literal["nav", "watch"] | None = None
    speed: float | None = Field(default=None, ge=0.5, le=4)


class DemoSpeed(BaseModel):
    speed: float = Field(ge=0.5, le=4)


class DemoMode(BaseModel):
    mode: Literal["nav", "watch"]


class DemoFlag(BaseModel):
    enabled: bool


@router.get("/demo")
async def v1_demo(request: Request):
    return S(request).demo.session.to_dict()


admin = [Depends(require_admin)]


@router.post("/demo/start", dependencies=admin)
async def v1_demo_start(request: Request, body: DemoStart | None = None):
    body = body or DemoStart()
    return await S(request).demo.start(body.mode, body.speed)


@router.post("/demo/pause", dependencies=admin)
async def v1_demo_pause(request: Request):
    return await S(request).demo.pause()


@router.post("/demo/speed", dependencies=admin)
async def v1_demo_speed(request: Request, body: DemoSpeed):
    return await S(request).demo.set_speed(body.speed)


@router.post("/demo/mode", dependencies=admin)
async def v1_demo_mode(request: Request, body: DemoMode):
    return await S(request).demo.set_mode(body.mode)


@router.post("/demo/scripted", dependencies=admin)
async def v1_demo_scripted(request: Request, body: DemoFlag):
    return await S(request).demo.set_scripted(body.enabled)


@router.post("/demo/stall", dependencies=admin)
async def v1_demo_stall(request: Request, body: DemoFlag):
    return await S(request).demo.set_stall(body.enabled)


@router.post("/demo/reset", dependencies=admin)
async def v1_demo_reset(request: Request):
    return await S(request).demo.reset()


# ---------------- WebSocket ----------------
@router.websocket("/live")
async def v1_live(ws: WebSocket):
    st = ws.app.state
    await ws.accept()
    client = st.live.add(ws)
    await client.send({
        "type": "hello", "time": datetime.now(timezone.utc).isoformat(),
        "sensors": st.poller.v1_sensors(), "hazards": st.hazards.payloads(),
        "demo": st.demo.session.to_dict(), "config": config_payload(st),
    })
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict) and msg.get("type") == "ping":
                await client.send({"type": "pong", "time": datetime.now(timezone.utc).isoformat()})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        st.live.remove(client)
