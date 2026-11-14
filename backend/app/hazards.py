"""Driver / operator / demo hazard reports (stalled cars, ...). Active set kept in memory."""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timedelta, timezone

from . import db

log = logging.getLogger(__name__)
LINK_RADIUS_M = 150.0


def hazard_payload(h: dict) -> dict:
    return {
        "id": str(h["id"]),
        "kind": h["kind"],
        "sensor_id": h["sensor_id"],
        "location": {"type": "Point", "coordinates": [h["lon"], h["lat"]]},
        "source": h["source"],
        "created_at": h["created_at"].isoformat(),
        "expires_at": h["expires_at"].isoformat(),
    }


class HazardStore:
    def __init__(self, pool, *, ttl_s: int, nearest_sensor, broadcast, network_getter):
        """nearest_sensor(lon, lat) -> (sensor_id, metres) | (None, inf)."""
        self.pool = pool
        self.ttl_s = ttl_s
        self.nearest_sensor = nearest_sensor
        self.broadcast = broadcast
        self.network_getter = network_getter
        self.active: dict[str, dict] = {}
        self._edge_cache: dict[str, set] = {}

    async def load(self) -> None:
        for h in await db.active_hazards(self.pool):
            self.active[str(h["id"])] = h

    def payloads(self) -> list[dict]:
        return [hazard_payload(h) for h in sorted(self.active.values(), key=lambda h: h["created_at"])]

    async def create(self, *, kind: str, lon: float, lat: float, source: str, sensor_id: str | None = None) -> dict:
        if sensor_id is None:
            sid, d = self.nearest_sensor(lon, lat)
            sensor_id = sid if d <= LINK_RADIUS_M else None
        now = datetime.now(timezone.utc)
        h = {"id": uuid.uuid4(), "kind": kind, "sensor_id": sensor_id, "lon": lon, "lat": lat,
             "source": source, "created_at": now, "expires_at": now + timedelta(seconds=self.ttl_s)}
        await db.insert_hazard(self.pool, h)
        self.active[str(h["id"])] = h
        p = hazard_payload(h)
        await self.broadcast({"type": "hazard.created", "hazard": p})
        log.info("hazard %s created (%s, sensor=%s, source=%s)", p["id"], kind, sensor_id, source)
        return p

    async def clear(self, hazard_id: str, reason: str) -> bool:
        h = self.active.pop(hazard_id, None)
        try:
            ok = await db.clear_hazard(self.pool, uuid.UUID(hazard_id), reason)
        except ValueError:
            return False
        self._edge_cache.pop(hazard_id, None)
        if h is not None or ok:
            await self.broadcast({"type": "hazard.cleared", "hazard_id": hazard_id, "reason": reason})
            return True
        return False

    async def clear_where(self, pred, reason: str) -> int:
        ids = [hid for hid, h in self.active.items() if pred(h)]
        for hid in ids:
            await self.clear(hid, reason)
        return len(ids)

    async def clear_for_sensor(self, sensor_id: str, reason: str) -> int:
        return await self.clear_where(lambda h: h["sensor_id"] == sensor_id, reason)

    def blocked(self) -> tuple[set[str], set]:
        """(sensor ids whose segments are blocked, extra edges for unlinked hazards)."""
        sensors, edges = set(), set()
        net = self.network_getter()
        for hid, h in self.active.items():
            if h["sensor_id"]:
                sensors.add(h["sensor_id"])
            elif net is not None:
                if hid not in self._edge_cache:
                    self._edge_cache[hid], _ = net.nearest_segment(h["lat"], h["lon"])
                edges |= self._edge_cache[hid]
        return sensors, edges

    async def run(self) -> None:
        while True:
            await asyncio.sleep(5)
            try:
                now = datetime.now(timezone.utc)
                await self.clear_where(lambda h: h["expires_at"] <= now, "expired")
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("hazard expiry failed")
