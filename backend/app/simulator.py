"""Replays the design handoff's 24 h per-minute profiles for the simulated FR-xx sensors.

Wall clock is mapped onto the CSV so that the moment the simulator first ran (the
anchor, persisted in `sim_state`) equals the end of the CSV (the handoff's demo start).
History before the anchor is the CSV played forward; after it, the CSV ping-pongs
(reverse, then forward, ...) so the replay never jumps. Sensors whose signal is 'lost'
stop reporting at the anchor (they stay offline, as in the designs).
"""
from __future__ import annotations

import asyncio
import csv
import logging
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger(__name__)
CSV_PATH = Path(__file__).resolve().parent.parent / "data" / "readings_24h.csv"
STEP_S = 10


def _parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_profiles(path: Path = CSV_PATH) -> tuple[datetime, datetime, dict[str, dict[int, float]]]:
    """-> (csv_start, csv_end, {sensor_id: {minute_index: depth_cm}}). Missing minutes = gaps."""
    by: dict[str, dict[int, float]] = defaultdict(dict)
    times = []
    rows = list(csv.DictReader(path.open()))
    for r in rows:
        times.append(_parse_ts(r["time"]))
    start, end = min(times), max(times)
    for r, t in zip(rows, times):
        if r["depth_cm"] != "":
            by[r["sensor_id"]][int((t - start).total_seconds() // 60)] = float(r["depth_cm"])
    return start, end, dict(by)


def csv_time_for(wall: datetime, anchor: datetime, csv_start: datetime, csv_end: datetime) -> datetime:
    """Map a wall-clock time onto the CSV timeline (forward before anchor, ping-pong after)."""
    span = (csv_end - csv_start).total_seconds()
    x = (wall - anchor).total_seconds()
    if x < 0:
        x = max(x, -span)
        return csv_end + timedelta(seconds=x)
    phase = x % (2 * span)
    if phase <= span:
        return csv_end - timedelta(seconds=phase)
    return csv_start + timedelta(seconds=phase - span)


def profile_value(series: dict[int, float], csv_t: datetime, csv_start: datetime) -> float | None:
    m = (csv_t - csv_start).total_seconds() / 60.0
    i = math.floor(m)
    f = m - i
    v0 = series.get(i)
    if f < 1e-9:
        return v0
    v1 = series.get(i + 1)
    if v0 is None or v1 is None:
        return None
    return v0 + (v1 - v0) * f


def floor_step(t: datetime, step: int = STEP_S) -> datetime:
    return datetime.fromtimestamp(math.floor(t.timestamp() / step) * step, tz=timezone.utc)


class ProfileSimulator:
    def __init__(self, pool, sensors: list[tuple[str, str | None]], scale: float = 1.0):
        """sensors: [(sensor_id, signal)] for the simulated sensors present in `sensors`."""
        self.pool = pool
        self.scale = scale
        self.csv_start, self.csv_end, self.profiles = load_profiles()
        self.sensors = [(sid, sig) for sid, sig in sensors if sid in self.profiles]
        self.anchor: datetime | None = None

    async def _anchor(self) -> datetime:
        row = await self.pool.fetchval("SELECT value FROM sim_state WHERE key = 'profile_anchor'")
        if row:
            return row
        now = datetime.now(timezone.utc)
        await self.pool.execute(
            "INSERT INTO sim_state (key, value) VALUES ('profile_anchor', $1) ON CONFLICT (key) DO NOTHING", now)
        return await self.pool.fetchval("SELECT value FROM sim_state WHERE key = 'profile_anchor'")

    def rows_between(self, sid: str, signal: str | None, t0: datetime, t1: datetime) -> list[tuple]:
        """Rows for wall times in (t0, t1], on the STEP_S grid."""
        out = []
        series = self.profiles[sid]
        t = floor_step(t0) + timedelta(seconds=STEP_S)
        while t <= t1:
            if not (signal == "lost" and t > self.anchor):
                v = profile_value(series, csv_time_for(t, self.anchor, self.csv_start, self.csv_end), self.csv_start)
                if v is not None:
                    out.append((t, sid, round(v * self.scale, 2), "profile"))
            t += timedelta(seconds=STEP_S)
        return out

    async def _catch_up(self) -> int:
        now = datetime.now(timezone.utc)
        horizon = now - (self.csv_end - self.csv_start)
        total = 0
        for sid, signal in self.sensors:
            last = await self.pool.fetchval(
                "SELECT max(time) FROM sim_readings WHERE sensor_id = $1 AND source = 'profile' AND time > $2",
                sid, horizon)
            rows = self.rows_between(sid, signal, last or horizon, now)
            for i in range(0, len(rows), 2000):
                await self.pool.executemany(
                    "INSERT INTO sim_readings (time, sensor_id, depth_cm, source) VALUES ($1, $2, $3, $4) "
                    "ON CONFLICT DO NOTHING", rows[i:i + 2000])
            total += len(rows)
        return total

    async def prepare(self) -> None:
        """Anchor + backfill; awaited before the poller starts so first-boot states are right."""
        if not self.sensors:
            log.info("no simulated sensors to replay")
            return
        self.anchor = await self._anchor()
        n = await self._catch_up()
        log.info("profile simulator: anchor %s, backfilled %d rows for %s", self.anchor.isoformat(), n,
                 ", ".join(s for s, _ in self.sensors))

    async def run(self) -> None:
        if not self.sensors:
            return
        if self.anchor is None:
            await self.prepare()
        while True:
            await asyncio.sleep(STEP_S)
            try:
                await self._catch_up()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("profile simulator tick failed")
