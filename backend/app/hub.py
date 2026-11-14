"""WebSocket client registry + targeted alerting / rerouting.

Every client gets broadcast sensor updates (map pins). A client that has sent
`set_route` also gets targeted alerts when a sensor on its route changes, and
a fresh route whenever flooding changes its best path.
"""
from __future__ import annotations

import asyncio
import itertools
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import WebSocket

from .routing import NoRoute, Route, RoadNetwork
from .status import Status, describe_depth

log = logging.getLogger(__name__)
_ids = itertools.count(1)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Client:
    ws: WebSocket
    id: int = field(default_factory=lambda: next(_ids))
    origin: tuple[float, float] | None = None       # (lat, lon)
    destination: tuple[float, float] | None = None
    route: Route | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def send(self, msg: dict) -> bool:
        try:
            async with self.lock:
                await self.ws.send_json(msg)
            return True
        except Exception:  # client went away mid-send
            return False


class Hub:
    def __init__(self) -> None:
        self.clients: dict[int, Client] = {}
        self.network: RoadNetwork | None = None
        self.sensors: dict[str, dict] = {}   # sensor_id -> public sensor payload (kept by poller)

    # ---------- state helpers ----------
    def flooded(self) -> set[str]:
        return {sid for sid, s in self.sensors.items() if s["status"] == Status.FLOODED.value}

    def snapshot(self) -> list[dict]:
        return list(self.sensors.values())

    # ---------- connection lifecycle ----------
    def add(self, ws: WebSocket) -> Client:
        c = Client(ws)
        self.clients[c.id] = c
        return c

    def remove(self, c: Client) -> None:
        self.clients.pop(c.id, None)

    async def broadcast(self, msg: dict) -> None:
        dead = []
        for c in list(self.clients.values()):
            if not await c.send(msg):
                dead.append(c)
        for c in dead:
            self.remove(c)

    # ---------- routing ----------
    async def compute_route(self, origin, destination) -> Route:
        if self.network is None:
            raise RuntimeError("routing unavailable: road graph not loaded")
        return await asyncio.to_thread(self.network.route, origin, destination, frozenset(self.flooded()))

    def _route_msg(self, route: Route | None, reason: str, message: str | None = None) -> dict:
        return {
            "type": "route",
            "reason": reason,             # requested | rerouted | restored | no_route
            "message": message,
            "route": route.to_geojson() if route else None,
            "at": now_iso(),
        }

    async def set_route(self, c: Client, origin, destination) -> None:
        c.origin, c.destination = origin, destination
        try:
            c.route = await self.compute_route(origin, destination)
            await c.send(self._route_msg(c.route, "requested"))
            # Warn up front about hazards already on the chosen path (caution spots).
            for sid in c.route.sensors_on_route:
                s = self.sensors.get(sid)
                if s and s["status"] == Status.CAUTION.value:
                    await c.send(self._alert(s, "caution"))
        except NoRoute:
            c.route = None
            await c.send(self._route_msg(None, "no_route", "Every route to your destination is flooded right now."))

    def clear_route(self, c: Client) -> None:
        c.origin = c.destination = c.route = None

    # ---------- alerts ----------
    @staticmethod
    def _alert(sensor: dict, severity: str, rerouted: bool = False) -> dict:
        name = sensor["name"]
        depth = describe_depth(sensor.get("depth_cm"))
        if severity == "flooded":
            msg = f"Flooded ahead at {name}, {depth}."
            msg += " Rerouting you." if rerouted else " Turn around, don't drown."
        elif severity == "caution":
            msg = f"Water rising at {name}, {depth}. Use caution."
        else:
            msg = f"Road reopened at {name}."
        return {
            "type": "alert",
            "alert": {
                "id": str(uuid.uuid4()),
                "severity": severity,          # flooded | caution | cleared
                "sensor_id": sensor["sensor_id"],
                "sensor_name": name,
                "depth_cm": sensor.get("depth_cm"),
                "lat": sensor["lat"],
                "lon": sensor["lon"],
                "message": msg,
                "at": now_iso(),
            },
        }

    async def on_status_change(self, sensor: dict, prev: Status, new: Status) -> None:
        """Called by the poller after `self.sensors` has been updated."""
        sid = sensor["sensor_id"]
        flood_changed = (prev is Status.FLOODED) != (new is Status.FLOODED)

        for c in list(self.clients.values()):
            if c.origin is None:
                continue
            on_route = c.route is not None and sid in c.route.sensors_on_route

            if not flood_changed:
                if new is Status.CAUTION and on_route:
                    await c.send(self._alert(sensor, "caution"))
                continue

            # Flood state changed -> recompute this client's route.
            old = c.route
            try:
                fresh = await self.compute_route(c.origin, c.destination)
            except NoRoute:
                c.route = None
                if on_route or old is not None:
                    await c.send(self._alert(sensor, "flooded", rerouted=False))
                    await c.send(self._route_msg(None, "no_route", "Every route to your destination is flooded right now."))
                continue
            except Exception:
                log.exception("reroute failed for client %s", c.id)
                continue

            c.route = fresh
            path_changed = old is None or old.path != fresh.path
            if new is Status.FLOODED:
                if on_route:
                    await c.send(self._alert(sensor, "flooded", rerouted=True))
                    await c.send(self._route_msg(fresh, "rerouted", f"Avoiding {sensor['name']}."))
                elif path_changed:
                    await c.send(self._route_msg(fresh, "rerouted"))
            else:  # flood cleared
                if path_changed:
                    if sid in (old.avoided_sensors if old else []):
                        await c.send(self._alert(sensor, "cleared"))
                    await c.send(self._route_msg(fresh, "restored", f"{sensor['name']} is passable again."))
