"""/v1/live WebSocket fan-out: hello, 2 s heartbeat, throttled readings, status/hazard/demo events."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from fastapi import WebSocket

log = logging.getLogger(__name__)
READING_MIN_INTERVAL_S = 2.0


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class LiveClient:
    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.lock = asyncio.Lock()

    async def send(self, msg: dict) -> bool:
        try:
            async with self.lock:
                await self.ws.send_json(msg)
            return True
        except Exception:
            return False


class Live:
    def __init__(self, sensor_payload):
        """sensor_payload: callable(sensor_id) -> v1 Sensor dict (or None if gone)."""
        self.clients: set[LiveClient] = set()
        self.sensor_payload = sensor_payload
        self._pending: set[str] = set()
        self._last_sent: dict[str, float] = {}

    def add(self, ws: WebSocket) -> LiveClient:
        c = LiveClient(ws)
        self.clients.add(c)
        return c

    def remove(self, c: LiveClient) -> None:
        self.clients.discard(c)

    async def broadcast(self, msg: dict) -> None:
        dead = [c for c in list(self.clients) if not await c.send(msg)]
        for c in dead:
            self.clients.discard(c)

    # ---- sensor events ----
    def queue_reading(self, sid: str) -> None:
        self._pending.add(sid)

    async def status_changed(self, sid: str, frm: str, to: str, depth, sensor: dict) -> None:
        self._pending.discard(sid)
        self._last_sent[sid] = time.monotonic()
        await self.broadcast({
            "type": "sensor.status_changed", "time": now_iso(), "sensor_id": sid,
            "from": frm, "to": to, "depth_cm": None if depth is None else round(depth, 1), "sensor": sensor,
        })

    async def flush_readings(self) -> None:
        now = time.monotonic()
        for sid in list(self._pending):
            if now - self._last_sent.get(sid, 0.0) < READING_MIN_INTERVAL_S:
                continue
            self._pending.discard(sid)
            payload = self.sensor_payload(sid)
            if payload is None:
                continue
            self._last_sent[sid] = now
            await self.broadcast({"type": "sensor.reading", "time": now_iso(), "sensor": payload})

    async def run(self) -> None:
        """Heartbeat every 2 s; flush throttled readings every 0.5 s."""
        last_hb = 0.0
        while True:
            try:
                await self.flush_readings()
                if time.monotonic() - last_hb >= 2.0:
                    last_hb = time.monotonic()
                    await self.broadcast({"type": "heartbeat", "time": now_iso()})
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("live loop failed")
            await asyncio.sleep(0.5)
