"""Stage demo session: shared play/pause/speed/mode state + scripted flood for water_tank_1.

Single-instance, in memory. Clients extrapolate demo_s between `demo.state` messages.
"""
from __future__ import annotations

import asyncio
import json
import logging
from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger(__name__)
SCENARIO = Path(__file__).resolve().parent.parent / "data" / "demo_scenario.json"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# ---------------- pure helpers ----------------
def current_demo_s(state: str, demo_s: float, at: datetime, speed: float, now: datetime, duration: float) -> float:
    """demo_s sampled at `at`, extrapolated to `now` while playing, clamped to [0, duration]."""
    if state != "playing":
        return max(0.0, min(duration, demo_s))
    return max(0.0, min(duration, demo_s + (now - at).total_seconds() * speed))


def interpolate(timeline: list[tuple[float, float]], s: float) -> float:
    """Linear interpolation of (demo_s, depth_cm) points; clamps at the ends."""
    if not timeline:
        return 0.0
    xs = [p[0] for p in timeline]
    if s <= xs[0]:
        return timeline[0][1]
    if s >= xs[-1]:
        return timeline[-1][1]
    i = bisect_right(xs, s)
    (x0, y0), (x1, y1) = timeline[i - 1], timeline[i]
    return y0 + (y1 - y0) * (s - x0) / (x1 - x0) if x1 != x0 else y1


def load_scenario(path: Path = SCENARIO) -> dict:
    return json.loads(path.read_text())


@dataclass
class DemoSession:
    state: str = "idle"           # idle | playing | paused
    mode: str = "nav"             # nav | watch
    speed: float = 2.0
    demo_s: float = 0.0
    at: datetime = field(default_factory=now_utc)
    scripted: bool = False
    stall: bool = False
    duration_s: float = 124.0     # length of the scripted water curve (depth holds at its last value after)
    max_s: float = 600.0          # the demo clock itself runs this long, so a driver who stops and
                                  # reroutes still has time to finish the trip

    def now_s(self, now: datetime | None = None) -> float:
        return current_demo_s(self.state, self.demo_s, self.at, self.speed, now or now_utc(), self.max_s)

    def resample(self, now: datetime | None = None) -> None:
        now = now or now_utc()
        self.demo_s, self.at = self.now_s(now), now

    def to_dict(self) -> dict:
        self.resample()
        return {
            "state": self.state, "mode": self.mode, "speed": self.speed,
            "demo_s": round(self.demo_s, 3), "at": self.at.isoformat(),
            "scripted": self.scripted, "stall": self.stall, "duration_s": self.duration_s, "max_s": self.max_s,
        }


class DemoController:
    """Owns the session; the app wires in callbacks for DB writes, hazards and broadcasts."""

    def __init__(self, *, sensor_id: str, stall_lnglat: tuple[float, float], scenario: dict | None = None,
                 depth_scale: float = 1.0):
        sc = scenario or load_scenario()
        self.timeline = [(float(p["demo_s"]), float(p["depth_cm"]) * depth_scale) for p in sc["timeline"]]
        self.sensor_id = sensor_id
        self.stall_lnglat = stall_lnglat
        self.session = DemoSession(duration_s=self.timeline[-1][0] if self.timeline else 124.0)
        # set by the app
        self.write_reading = None      # async (sensor_id, depth_cm) -> None
        self.delete_demo_rows = None   # async () -> None
        self.set_stall_hazard = None   # async (enabled: bool) -> None
        self.on_reset = None           # async () -> None
        self.broadcast = None          # async (msg) -> None
        self._lock = asyncio.Lock()

    async def _publish(self) -> dict:
        d = self.session.to_dict()
        if self.broadcast:
            await self.broadcast({"type": "demo.state", "demo": d})
        return d

    async def start(self, mode: str | None = None, speed: float | None = None) -> dict:
        async with self._lock:
            s = self.session
            s.resample()
            if s.demo_s >= s.max_s:
                s.demo_s = 0.0
            if mode:
                s.mode = mode
            if speed:
                s.speed = speed
            s.state = "playing"
            s.at = now_utc()
            return await self._publish()

    async def pause(self) -> dict:
        async with self._lock:
            self.session.resample()
            if self.session.state == "playing":
                self.session.state = "paused"
            return await self._publish()

    async def set_speed(self, speed: float) -> dict:
        async with self._lock:
            self.session.resample()
            self.session.speed = speed
            return await self._publish()

    async def set_mode(self, mode: str) -> dict:
        async with self._lock:
            self.session.resample()
            self.session.mode = mode
            return await self._publish()

    async def set_scripted(self, enabled: bool) -> dict:
        async with self._lock:
            self.session.scripted = enabled
            if enabled:
                await self._write_now()
            return await self._publish()

    async def set_stall(self, enabled: bool) -> dict:
        async with self._lock:
            self.session.stall = enabled
            if self.set_stall_hazard:
                await self.set_stall_hazard(enabled)
            return await self._publish()

    async def reset(self) -> dict:
        async with self._lock:
            s = self.session
            s.state, s.demo_s, s.at, s.stall = "idle", 0.0, now_utc(), False
            if self.set_stall_hazard:
                await self.set_stall_hazard(False)
            if self.delete_demo_rows:
                await self.delete_demo_rows()
            if self.on_reset:
                await self.on_reset()
            if s.scripted:
                await self._write_now()
            return await self._publish()

    async def _write_now(self) -> None:
        if self.write_reading:
            await self.write_reading(self.sensor_id, interpolate(self.timeline, self.session.now_s()))

    async def run(self) -> None:
        """Every real second: finish the demo at its end; write the scripted depth."""
        while True:
            try:
                async with self._lock:
                    s = self.session
                    if s.state == "playing" and s.now_s() >= s.max_s:
                        s.resample()
                        s.state = "paused"
                        await self._publish()
                    if s.scripted:
                        await self._write_now()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("demo tick failed")
            await asyncio.sleep(1.0)
