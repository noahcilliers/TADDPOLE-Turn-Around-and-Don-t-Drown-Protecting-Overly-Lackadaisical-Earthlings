"""Poll loop: read every sensor's depths (via flood_readings), classify, persist + push changes.

Status = clear/caution/flooded from depth (status.classify), overridden by `offline` when the
sensor has sent nothing for OFFLINE_AFTER_S.
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import asyncpg

from . import db
from .config import Settings
from .hub import Hub
from .status import RISK_ORDER, Status, classify, rise_rate, smoothed_depth

log = logging.getLogger(__name__)


@dataclass
class SensorState:
    status: Status = Status.CLEAR
    depth: float | None = None
    rate: float | None = None
    last_time: datetime | None = None
    status_since: datetime | None = None


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class Poller:
    def __init__(self, pool: asyncpg.Pool, hub: Hub, cfg: Settings):
        self.pool, self.hub, self.cfg = pool, hub, cfg
        self.state: dict[str, SensorState] = {}
        self.sensor_rows: dict[str, db.SensorRow] = {}
        self._last_sensor_refresh = 0.0
        self._warned_unknown: set[str] = set()
        self.last_tick: datetime | None = None
        self.last_error: str | None = None
        # wired by the app
        self.demo_sensor: str = ""
        self.demo_scripted = lambda: False
        self.live = None           # app.live.Live
        self.hazards = None        # app.hazards.HazardStore

    @property
    def status(self) -> dict[str, Status]:
        return {sid: st.status for sid, st in self.state.items()}

    async def start(self) -> None:
        for sid, rec in (await db.load_status(self.pool)).items():
            self.state[sid] = SensorState(
                status=Status(rec["status"]), depth=rec["depth_cm"], rate=rec["rise_cm_per_min"],
                status_since=rec["changed_at"],
            )
        await self.refresh_sensors(force=True)
        for sid in self.sensor_rows:
            self.hub.sensors.setdefault(sid, self._payload(sid))

    async def refresh_sensors(self, force: bool = False) -> None:
        if not force and time.monotonic() - self._last_sensor_refresh < self.cfg.sensor_refresh_s:
            return
        rows = await db.load_sensors(self.pool)
        changed = {r.sensor_id: r for r in rows} != self.sensor_rows
        self.sensor_rows = {r.sensor_id: r for r in rows}
        self._last_sensor_refresh = time.monotonic()
        for sid in await db.unknown_sensor_ids(self.pool, self.cfg.sensor_refresh_s * 2):
            if sid not in self._warned_unknown:
                self._warned_unknown.add(sid)
                log.warning("water_levels has readings from %r but no row in `sensors`; add its name/lat/lon/baseline_cm to show it", sid)
        for r in rows:
            if r.baseline_cm is None and not r.simulated and r.sensor_id not in self._warned_unknown:
                self._warned_unknown.add(r.sensor_id)
                log.warning("sensor %s has no baseline_cm; depth can't be computed until it's set", r.sensor_id)
        for sid in list(self.hub.sensors):
            if sid not in self.sensor_rows:
                del self.hub.sensors[sid]
        if changed and self.hub.network is not None:
            dists = await asyncio.to_thread(
                self.hub.network.map_sensors, [(r.sensor_id, r.lat, r.lon) for r in rows]
            )
            for sid, d in dists.items():
                lvl = logging.WARNING if d > 75 else logging.INFO
                log.log(lvl, "sensor %s snapped to road segment %.0f m away", sid, d)

    # ---------- payloads ----------
    def _payload(self, sid: str) -> dict:
        """Legacy payload for GET /sensors and /ws."""
        r = self.sensor_rows[sid]
        st = self.state.get(sid, SensorState())
        stale = st.last_time is None or (
            datetime.now(timezone.utc) - st.last_time
        ).total_seconds() > self.cfg.stale_after_s
        return {
            "sensor_id": sid,
            "name": r.name,
            "lat": r.lat,
            "lon": r.lon,
            "status": st.status.value,
            "depth_cm": None if st.depth is None else round(st.depth, 1),
            "rise_cm_per_min": None if st.rate is None else round(st.rate, 2),
            "last_reading_at": st.last_time.isoformat() if st.last_time else None,
            "stale": stale,
        }

    def v1_sensor(self, sid: str, near: tuple[float, float] | None = None) -> dict:
        """`Sensor` per API_V1.md. near = (lng, lat)."""
        r = self.sensor_rows[sid]
        st = self.state.get(sid, SensorState())
        seg = self.hub.network.segment_coords(sid) if self.hub.network else None
        off = st.status is Status.OFFLINE
        out = {
            "id": sid,
            "name": r.name,
            "road": r.road,
            "simulated": bool(r.simulated),
            "location": {"type": "Point", "coordinates": [r.lon, r.lat]},
            "segment": {"type": "LineString", "coordinates": seg} if seg else None,
            "battery_pct": r.battery_pct,
            "signal": r.signal,
            "calibrated_at": r.calibrated_at.isoformat() if r.calibrated_at else None,
            "current": {
                "status": st.status.value,
                "depth_cm": None if st.depth is None or off else round(st.depth, 1),
                "rate_cm_per_min": None if st.rate is None or off else round(st.rate, 2),
                "last_reading_at": st.last_time.isoformat() if st.last_time else None,
                "status_since": st.status_since.isoformat() if st.status_since else None,
            },
        }
        if near is not None:
            out["distance_m"] = round(haversine_m(near[0], near[1], r.lon, r.lat))
        return out

    def v1_sensors(self, near=None, sort: str = "risk") -> list[dict]:
        items = [self.v1_sensor(sid, near) for sid in self.sensor_rows]
        if sort == "near" and near is not None:
            items.sort(key=lambda s: s["distance_m"])
        else:
            items.sort(key=lambda s: (RISK_ORDER[s["current"]["status"]], -(s["current"]["depth_cm"] or 0), s["name"]))
        return items

    def demo_source(self) -> str:
        return "demo" if self.demo_scripted() else "device"

    async def reset_sensor(self, sid: str) -> None:
        """Demo reset: forget hysteresis so a drained scripted sensor returns straight to clear."""
        st = self.state.get(sid)
        if st is not None and st.status in (Status.CAUTION, Status.FLOODED):
            st.depth = None
            st.status = Status.CLEAR  # next tick re-classifies from scratch and records the change
            self._force_change = getattr(self, "_force_change", set()) | {sid}

    # ---------- loop ----------
    async def tick(self) -> None:
        cfg = self.cfg
        await self.refresh_sensors()
        states = await db.reading_state(
            self.pool,
            n_recent=cfg.median_of,
            lookback_s=cfg.offline_after_s,
            rise_window_s=cfg.rise_window_s,
            demo_sensor=self.demo_sensor,
            demo_source=self.demo_source(),
        )
        now = datetime.now(timezone.utc)
        forced = getattr(self, "_force_change", set())
        self._force_change = set()
        for sid, rs in states.items():
            if sid not in self.sensor_rows:
                continue
            known = sid in self.state
            st = self.state.setdefault(sid, SensorState(status_since=now))
            prev = st.status

            depth = smoothed_depth(rs.recent_depths, cfg.median_of)
            rise = rise_rate(depth, rs.last_time, rs.window_start_depth, rs.window_start_time)
            last_any = rs.last_any
            offline = last_any is None or (now - last_any).total_seconds() > cfg.offline_after_s
            if offline:
                new = Status.OFFLINE
                depth = rise = None
            else:
                base = Status.CLEAR if prev is Status.OFFLINE else prev
                new = classify(
                    base, depth, rise,
                    caution_cm=cfg.caution_cm, flooded_cm=cfg.flooded_cm,
                    rise_rate_cm_per_min=cfg.rise_rate_cm_per_min, hysteresis_cm=cfg.hysteresis_cm,
                )

            # A demo reset flipped the in-memory status to clear; report the transition from
            # what clients last saw (the persisted status) so they get a status_changed event.
            if sid in forced:
                prev = Status(self.hub.sensors.get(sid, {}).get("status", prev.value))

            changed = new is not prev
            st.status, st.depth, st.rate, st.last_time = new, depth, rise, last_any
            if changed or st.status_since is None:
                st.status_since = now

            payload = self._payload(sid)
            old_payload = self.hub.sensors.get(sid)
            self.hub.sensors[sid] = payload
            visible = old_payload is None or _visible_diff(old_payload, payload)

            if changed or not known or (visible and depth is not None):
                await db.record_evaluation(
                    self.pool, sensor_id=sid, prev_status=prev.value if known else None,
                    status=new.value, depth_cm=depth, rise_cm_per_min=rise,
                    changed=changed or not known,
                )

            if changed:
                log.info("sensor %s: %s -> %s (depth=%s, rise=%s)", sid, prev.value, new.value, depth, rise)
                await self.hub.broadcast({"type": "sensor_update", "sensor": payload})
                await self.hub.on_status_change(payload, prev, new)
                if self.live is not None:
                    await self.live.status_changed(sid, prev.value, new.value, depth, self.v1_sensor(sid))
                if new is Status.CLEAR and self.hazards is not None:
                    await self.hazards.clear_for_sensor(sid, "sensor_clear")
            elif visible:
                await self.hub.broadcast({"type": "sensor_update", "sensor": payload})
                if self.live is not None:
                    self.live.queue_reading(sid)
            elif (self.live is not None and old_payload is not None
                  and old_payload.get("last_reading_at") != payload.get("last_reading_at")):
                # Fresh reading at the same depth: still stream it (throttled to 1 per 2 s in
                # live.py) so clients see "Updated 2 s ago" instead of a stalled sensor.
                self.live.queue_reading(sid)

        self.last_tick = now

    async def run(self) -> None:
        backoff = 1.0
        while True:
            started = time.monotonic()
            try:
                await self.tick()
                self.last_error = None
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # DB blip, network, etc. Keep the loop alive.
                self.last_error = f"{type(exc).__name__}: {exc}"
                log.exception("poll tick failed; retrying in %.0fs", backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
                continue
            await asyncio.sleep(max(0.0, self.cfg.poll_interval_s - (time.monotonic() - started)))


def _visible_diff(a: dict, b: dict) -> bool:
    """Only re-broadcast when something a viewer would notice changed."""
    return (
        a["status"] != b["status"]
        or a["stale"] != b["stale"]
        or a["depth_cm"] != b["depth_cm"]
        or a["name"] != b["name"]
        or (a["lat"], a["lon"]) != (b["lat"], b["lon"])
    )
