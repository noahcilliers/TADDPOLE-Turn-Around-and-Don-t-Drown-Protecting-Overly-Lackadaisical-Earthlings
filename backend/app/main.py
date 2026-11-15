"""FastAPI app: REST + WebSocket, with the poller running in the background."""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

from . import db
from .camera import CameraGate
from .config import Settings, get_settings
from .hub import Hub, now_iso
from .demo import DemoController
from .discord_alerts import DiscordAlerts, build_message
from .hazards import HazardStore
from .live import Live
from .poller import Poller, haversine_m
from .routing import NoRoute, RoadNetwork
from .simulator import ProfileSimulator
from . import v1

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("floodroute")


class LatLon(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)

    def t(self) -> tuple[float, float]:
        return (self.lat, self.lon)


class SetRoute(BaseModel):
    type: str
    origin: LatLon
    destination: LatLon


class Simulate(BaseModel):
    depth_cm: float = Field(ge=0, le=500)


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = get_settings()
    hub = Hub()

    graph = Path(cfg.graph_path)
    if graph.exists():
        hub.network = await asyncio.to_thread(RoadNetwork.from_graphml, graph)
        hub.network.prefs.flood_buffer_m = cfg.flood_buffer_m
        log.info("road graph loaded: %d nodes, %d edges", hub.network.G.number_of_nodes(), hub.network.G.number_of_edges())
    else:
        log.warning("road graph %s not found: routing disabled (run scripts/build_graph.py)", graph)

    pool = await db.create_pool(cfg.database_url)
    await db.migrate(pool)
    poller = Poller(pool, hub, cfg)

    live = Live(lambda sid: poller.v1_sensor(sid) if sid in poller.sensor_rows else None)

    def nearest_sensor(lon: float, lat: float):
        best, best_d = None, float("inf")
        for r in poller.sensor_rows.values():
            d = haversine_m(lon, lat, r.lon, r.lat)
            if d < best_d:
                best, best_d = r.sensor_id, d
        return best, best_d

    hazards = HazardStore(pool, ttl_s=cfg.hazard_ttl_s, nearest_sensor=nearest_sensor,
                          broadcast=live.broadcast, network_getter=lambda: hub.network)
    await hazards.load()

    demo = DemoController(sensor_id=cfg.demo_sensor_id, stall_lnglat=tuple(v1.DEMO["stall_lnglat"]),
                          depth_scale=cfg.effective_sim_scale)

    async def write_demo(sid, depth):
        await db.insert_demo_reading(pool, sid, depth)

    async def delete_demo():
        await db.delete_demo_rows(pool)

    async def stall_hazard(enabled: bool):
        await hazards.clear_where(lambda h: h["source"] == "demo", "demo")
        if enabled:
            lng, lat = v1.DEMO["stall_lnglat"]
            await hazards.create(kind="stalled_vehicle", lon=lng, lat=lat, source="demo", sensor_id=cfg.demo_sensor_id)

    async def demo_reset():
        await poller.reset_sensor(cfg.demo_sensor_id)

    demo.write_reading, demo.delete_demo_rows = write_demo, delete_demo
    demo.set_stall_hazard, demo.on_reset, demo.broadcast = stall_hazard, demo_reset, live.broadcast

    poller.demo_sensor = cfg.demo_sensor_id
    poller.demo_scripted = lambda: demo.session.scripted
    poller.live, poller.hazards = live, hazards
    discord = DiscordAlerts(
        cfg.discord_webhook_url, notify_on=cfg.discord_notify_on, cooldown_s=cfg.discord_cooldown_s,
        include_simulated=cfg.discord_include_simulated, app_url=cfg.discord_app_url,
        mention=cfg.discord_mention,
    )
    poller.discord = discord
    camera = CameraGate(
        api_key=cfg.gemini_api_key, camera=cfg.camera, camera_token=cfg.camera_token, sensor_ids=cfg.camera_sensors.split(","),
        model=cfg.gemini_model, verdict_max_age_s=cfg.camera_verdict_max_age_s,
        recheck_s=cfg.camera_recheck_s, timeout_s=cfg.camera_timeout_s,
    )
    camera.start()
    poller.camera = camera
    await poller.start()

    sim = ProfileSimulator(pool, [(r.sensor_id, r.signal) for r in poller.sensor_rows.values() if r.simulated],
                           scale=cfg.effective_sim_scale)
    await sim.prepare()
    tasks = [
        asyncio.create_task(poller.run(), name="poller"),
        asyncio.create_task(live.run(), name="live"),
        asyncio.create_task(hazards.run(), name="hazards"),
        asyncio.create_task(demo.run(), name="demo"),
        asyncio.create_task(sim.run(), name="profile-sim"),
        asyncio.create_task(discord.run(), name="discord"),
    ]

    app.state.cfg, app.state.hub, app.state.pool, app.state.poller = cfg, hub, pool, poller
    app.state.discord, app.state.camera = discord, camera
    app.state.live, app.state.hazards, app.state.demo = live, hazards, demo
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await pool.close()


app = FastAPI(title="Flood Route API", lifespan=lifespan)
app.include_router(v1.router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)


def hub_dep() -> Hub:
    return app.state.hub


def require_admin(x_admin_token: str = Header(default="")) -> None:
    token = app.state.cfg.admin_token
    if not token:
        raise HTTPException(404, "admin endpoints disabled (set ADMIN_TOKEN)")
    if not hmac.compare_digest(x_admin_token, token):
        raise HTTPException(401, "bad admin token")


def _parse_ll(s: str) -> tuple[float, float]:
    try:
        lat, lon = (float(x) for x in s.split(","))
        LatLon(lat=lat, lon=lon)
        return lat, lon
    except Exception:
        raise HTTPException(422, f"expected 'lat,lon', got {s!r}")


# ---------------- REST ----------------
@app.get("/health")
async def health():
    p: Poller = app.state.poller
    return {
        "ok": p.last_error is None,
        "last_poll": p.last_tick.isoformat() if p.last_tick else None,
        "last_error": p.last_error,
        "routing": app.state.hub.network is not None,
        "clients": len(app.state.hub.clients),
        "camera": app.state.camera.snapshot(),
    }


@app.get("/camera/{sensor_id}/last.jpg")
async def camera_last_photo(sensor_id: str):
    """The last photo the camera check sent to Gemini for this sensor (for aiming / debugging)."""
    sc = app.state.camera.sensors.get(sensor_id)
    if sc is None or sc.last_jpeg is None:
        raise HTTPException(404, "no camera photo yet for this sensor")
    return Response(sc.last_jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/config")
async def public_config(cfg: Settings = Depends(get_settings), hub: Hub = Depends(hub_dep)):
    return {
        "thresholds_cm": {"caution": cfg.caution_cm, "flooded": cfg.flooded_cm},
        "rise_rate_cm_per_min": cfg.rise_rate_cm_per_min,
        "bounds": hub.network.bounds if hub.network else None,  # [west, south, east, north]
    }


@app.get("/sensors")
async def sensors(hub: Hub = Depends(hub_dep)):
    return hub.snapshot()


@app.get("/sensors/{sensor_id}/history")
async def sensor_history(sensor_id: str, minutes: int = Query(60, ge=1, le=60 * 24 * 7)):
    if sensor_id not in app.state.hub.sensors:
        raise HTTPException(404, "unknown sensor")
    return await db.history(app.state.pool, sensor_id, minutes)


@app.get("/events")
async def events(limit: int = Query(50, ge=1, le=500), sensor_id: str | None = None):
    return await db.recent_events(app.state.pool, limit, sensor_id)


@app.get("/route")
async def route(from_: str = Query(..., alias="from"), to: str = Query(...), hub: Hub = Depends(hub_dep)):
    if hub.network is None:
        raise HTTPException(503, "routing unavailable")
    try:
        r = await hub.compute_route(_parse_ll(from_), _parse_ll(to))
    except NoRoute:
        raise HTTPException(409, "no flood-free route")
    return r.to_geojson()


@app.post("/admin/sensors/{sensor_id}/simulate", dependencies=[Depends(require_admin)])
async def simulate(sensor_id: str, body: Simulate):
    """Demo insurance: write a fake reading so the full pipeline runs without hardware."""
    if not await db.insert_simulated_reading(app.state.pool, sensor_id, body.depth_cm):
        raise HTTPException(404, "unknown sensor or sensor has no baseline_cm")
    return {"ok": True, "sensor_id": sensor_id, "depth_cm": body.depth_cm}


@app.post("/admin/discord/test", dependencies=[Depends(require_admin)])
async def discord_test(sensor_id: str | None = None):
    """Post a sample `flooded` alert to the Discord webhook (skips filters and cooldown)."""
    d: DiscordAlerts = app.state.discord
    if not d.enabled:
        raise HTTPException(409, "Discord alerts are off (set DISCORD_WEBHOOK_URL)")
    rows = app.state.poller.sensor_rows
    row = rows.get(sensor_id or app.state.cfg.demo_sensor_id) or next(iter(rows.values()), None)
    if row is None:
        raise HTTPException(404, "no sensors loaded")
    body = build_message("flooded", row, 30.0, 2.5, app_url=d.app_url, mention=d.mention)
    body["embeds"][0]["title"] = "[TEST] " + body["embeds"][0]["title"]
    try:
        await d.send_now(body)
    except Exception as exc:
        raise HTTPException(502, f"Discord rejected the test alert: {exc}")
    return {"ok": True, "sensor_id": row.sensor_id}


# ---------------- WebSocket ----------------
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    hub: Hub = app.state.hub
    await ws.accept()
    client = hub.add(ws)
    await client.send({"type": "hello", "client_id": client.id, "sensors": hub.snapshot(), "at": now_iso()})
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await client.send({"type": "error", "message": "messages must be JSON"})
                continue
            kind = msg.get("type") if isinstance(msg, dict) else None
            if kind == "set_route":
                try:
                    req = SetRoute.model_validate(msg)
                except ValidationError as e:
                    await client.send({"type": "error", "message": f"bad set_route: {e.errors()[0]['msg']}"})
                    continue
                if hub.network is None:
                    await client.send({"type": "error", "message": "routing unavailable"})
                    continue
                await hub.set_route(client, req.origin.t(), req.destination.t())
            elif kind == "clear_route":
                hub.clear_route(client)
            elif kind == "ping":
                await client.send({"type": "pong", "at": now_iso()})
            else:
                await client.send({"type": "error", "message": f"unknown message type {kind!r}"})
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("ws client %s crashed", client.id)
    finally:
        hub.remove(client)
