"""All SQL lives here. asyncpg pool against Tiger Data (TimescaleDB)."""
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import asyncpg

MIGRATIONS = Path(__file__).with_name("migrations.sql")
MIGRATION_LOCK_KEY = 72_410_001  # arbitrary advisory-lock id


@dataclass
class SensorRow:
    sensor_id: str
    name: str
    lat: float
    lon: float
    baseline_cm: float | None
    road: str | None = None
    simulated: bool = False
    battery_pct: int | None = None
    signal: str | None = None
    calibrated_at: object | None = None   # date


@dataclass
class SensorReadingState:
    sensor_id: str
    recent_depths: list[float]          # newest first
    last_time: datetime | None
    window_start_depth: float | None    # median of the oldest 3 readings in the rise window
    window_start_time: datetime | None
    last_any: datetime | None = None    # latest reading at all (for offline detection)


async def create_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(dsn, min_size=1, max_size=5, command_timeout=10)


async def migrate(pool: asyncpg.Pool) -> None:
    sql = MIGRATIONS.read_text()
    async with pool.acquire() as con:
        async with con.transaction():
            await con.execute("SELECT pg_advisory_xact_lock($1)", MIGRATION_LOCK_KEY)
            await con.execute(sql)


async def load_sensors(pool: asyncpg.Pool) -> list[SensorRow]:
    rows = await pool.fetch(
        "SELECT sensor_id, name, lat, lon, baseline_cm, road, simulated, battery_pct, signal, calibrated_at "
        "FROM sensors ORDER BY sensor_id"
    )
    return [SensorRow(**dict(r)) for r in rows]


async def load_status(pool: asyncpg.Pool) -> dict[str, asyncpg.Record]:
    rows = await pool.fetch("SELECT * FROM sensor_status")
    return {r["sensor_id"]: r for r in rows}


async def unknown_sensor_ids(pool: asyncpg.Pool, window_s: int) -> list[str]:
    """sensor_ids the writer is sending that have no row in `sensors` (so no map pin)."""
    rows = await pool.fetch(
        """
        SELECT DISTINCT w.sensor_id
          FROM water_levels w
         WHERE w.time > now() - make_interval(secs => $1)
           AND NOT EXISTS (SELECT 1 FROM sensors s WHERE s.sensor_id = w.sensor_id)
        """,
        window_s,
    )
    return [r["sensor_id"] for r in rows]


# Source filter for the real demo sensor: device rows normally, scripted demo rows while the
# stage demo's "scripted flood" is on. Every other sensor uses all of its rows.
SRC = "(fr.sensor_id <> $4 OR fr.source = $5)"


async def reading_state(
    pool: asyncpg.Pool, n_recent: int, lookback_s: int, rise_window_s: int,
    demo_sensor: str = "", demo_source: str = "device",
) -> dict[str, SensorReadingState]:
    """Latest N depths + least-squares rise rate (cm/min) per sensor."""
    rows = await pool.fetch(
        """
        SELECT s.sensor_id,
               recent.depths,
               recent.last_time,
               rise.d AS window_start_depth,
               rise.t AS window_start_time,
               anyr.last_any
          FROM sensors s
          LEFT JOIN LATERAL (
                SELECT array_agg(depth_cm ORDER BY time DESC) AS depths,
                       max(time)                              AS last_time
                  FROM (SELECT time, depth_cm
                          FROM flood_readings fr
                         WHERE fr.sensor_id = s.sensor_id
                           AND fr.depth_cm IS NOT NULL
                           AND fr.time > now() - make_interval(secs => $2)
                           AND (fr.sensor_id <> $4 OR fr.source = $5)
                         ORDER BY fr.time DESC
                         LIMIT $1) latest
               ) recent ON TRUE
          LEFT JOIN LATERAL (
                SELECT max(fr.time) AS last_any
                  FROM flood_readings fr
                 WHERE fr.sensor_id = s.sensor_id
                   AND fr.time > now() - INTERVAL '2 days'
                   AND (fr.sensor_id <> $4 OR fr.source = $5)
               ) anyr ON TRUE
          -- Median of the oldest 3 readings in the rise window (median, so one spike can't fake a
          -- rise or hide one); the poller compares it with the
          -- smoothed current depth to get a net rise rate (negative once water drains).
          LEFT JOIN LATERAL (
                SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY depth_cm) AS d,
                       to_timestamp(avg(extract(epoch FROM time))) AS t
                  FROM (SELECT fr.depth_cm, fr.time FROM flood_readings fr
                         WHERE fr.sensor_id = s.sensor_id AND fr.depth_cm IS NOT NULL
                           AND fr.time > now() - make_interval(secs => $3)
                           AND (fr.sensor_id <> $4 OR fr.source = $5)
                         ORDER BY fr.time ASC LIMIT 3) oldest
               ) rise ON TRUE
        """,
        n_recent,
        lookback_s,
        rise_window_s,
        demo_sensor,
        demo_source,
    )
    return {
        r["sensor_id"]: SensorReadingState(
            sensor_id=r["sensor_id"],
            recent_depths=list(r["depths"] or []),
            last_time=r["last_time"],
            window_start_depth=r["window_start_depth"],
            window_start_time=r["window_start_time"],
            last_any=r["last_any"],
        )
        for r in rows
    }


async def record_evaluation(
    pool: asyncpg.Pool,
    *,
    sensor_id: str,
    prev_status: str | None,
    status: str,
    depth_cm: float | None,
    rise_cm_per_min: float | None,
    changed: bool,
) -> None:
    async with pool.acquire() as con:
        async with con.transaction():
            await con.execute(
                """
                INSERT INTO sensor_status (sensor_id, status, depth_cm, rise_cm_per_min, changed_at, updated_at)
                VALUES ($1, $2, $3, $4, now(), now())
                ON CONFLICT (sensor_id) DO UPDATE
                   SET status = EXCLUDED.status,
                       depth_cm = EXCLUDED.depth_cm,
                       rise_cm_per_min = EXCLUDED.rise_cm_per_min,
                       changed_at = CASE WHEN $5 THEN now() ELSE sensor_status.changed_at END,
                       updated_at = now()
                """,
                sensor_id, status, depth_cm, rise_cm_per_min, changed,
            )
            if changed:
                await con.execute(
                    """
                    INSERT INTO status_events (time, sensor_id, prev_status, status, depth_cm, rise_cm_per_min)
                    VALUES (now(), $1, $2, $3, $4, $5)
                    """,
                    sensor_id, prev_status, status, depth_cm, rise_cm_per_min,
                )


async def history(pool: asyncpg.Pool, sensor_id: str, minutes: int) -> list[dict]:
    rows = await pool.fetch(
        """
        SELECT h.bucket,
               GREATEST(0, s.baseline_cm - h.avg_distance_in * 2.54) AS avg_depth_cm,
               GREATEST(0, s.baseline_cm - h.min_distance_in * 2.54) AS max_depth_cm,
               h.n
          FROM water_levels_1m h JOIN sensors s USING (sensor_id)
         WHERE h.sensor_id = $1 AND h.bucket > now() - make_interval(mins => $2)
         ORDER BY h.bucket
        """,
        sensor_id, minutes,
    )
    return [dict(r) for r in rows]


async def recent_events(pool: asyncpg.Pool, limit: int, sensor_id: str | None) -> list[dict]:
    rows = await pool.fetch(
        """
        SELECT e.time, e.sensor_id, s.name, e.prev_status, e.status, e.depth_cm, e.rise_cm_per_min
          FROM status_events e JOIN sensors s USING (sensor_id)
         WHERE ($2::text IS NULL OR e.sensor_id = $2)
           AND e.time > now() - INTERVAL '30 days'
         ORDER BY e.time DESC
         LIMIT $1
        """,
        limit, sensor_id,
    )
    return [dict(r) for r in rows]


async def insert_simulated_reading(pool: asyncpg.Pool, sensor_id: str, depth_cm: float) -> bool:
    """Demo override: write a raw reading into water_levels exactly like the ESP32 writer
    does, so the whole pipeline runs. Returns False if the sensor is unknown/uncalibrated."""
    result = await pool.execute(
        """
        INSERT INTO water_levels (time, sensor_id, distance_inches)
        SELECT now(), sensor_id, GREATEST(0, baseline_cm - $2) / 2.54
          FROM sensors WHERE sensor_id = $1 AND baseline_cm IS NOT NULL
        """,
        sensor_id, depth_cm,
    )
    return result.endswith(" 1")


# ======================= v1 queries =======================
async def readings(
    pool: asyncpg.Pool, sensor_id: str, start: datetime, end: datetime,
    demo_sensor: str = "", demo_source: str = "device",
) -> list[tuple[datetime, float]]:
    """Raw (time, depth_cm) readings in [start, end), oldest first, for spike filtering."""
    rows = await pool.fetch(
        """
        SELECT fr.time, fr.depth_cm
          FROM flood_readings fr
         WHERE fr.sensor_id = $1 AND fr.time >= $2 AND fr.time < $3 AND fr.depth_cm IS NOT NULL
           AND (fr.sensor_id <> $4 OR fr.source = $5)
         ORDER BY fr.time
        """,
        sensor_id, start, end, demo_sensor, demo_source,
    )
    return [(r["time"], float(r["depth_cm"])) for r in rows]


async def status_changes(pool: asyncpg.Pool, sensor_id: str, since_s: int, limit: int) -> list[dict]:
    rows = await pool.fetch(
        """
        SELECT time, prev_status AS from_status, status AS to_status, depth_cm
          FROM status_events
         WHERE sensor_id = $1 AND time > now() - make_interval(secs => $2)
           AND prev_status IS NOT NULL AND prev_status <> status
         ORDER BY time DESC LIMIT $3
        """,
        sensor_id, since_s, limit,
    )
    return [dict(r) for r in rows]


async def events_v1(pool: asyncpg.Pool, since_s: int, limit: int) -> list[dict]:
    rows = await pool.fetch(
        """
        SELECT * FROM (
            SELECT 'status_change' AS kind, e.time, e.sensor_id, s.name AS title,
                   e.prev_status AS from_status, e.status AS to_status, e.depth_cm,
                   NULL::text AS hazard_kind, NULL::uuid AS hazard_id, NULL::text AS source
              FROM status_events e JOIN sensors s USING (sensor_id)
             WHERE e.time > now() - make_interval(secs => $1)
               AND e.prev_status IS NOT NULL AND e.prev_status <> e.status
            UNION ALL
            SELECT 'hazard', h.created_at, h.sensor_id, coalesce(s.name, 'Reported hazard'),
                   NULL, NULL, NULL, h.kind, h.id, h.source
              FROM hazards h LEFT JOIN sensors s USING (sensor_id)
             WHERE h.created_at > now() - make_interval(secs => $1)
        ) x ORDER BY time DESC LIMIT $2
        """,
        since_s, limit,
    )
    return [dict(r) for r in rows]


async def insert_hazard(pool: asyncpg.Pool, h: dict) -> None:
    await pool.execute(
        """
        INSERT INTO hazards (id, kind, sensor_id, lon, lat, source, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """,
        h["id"], h["kind"], h["sensor_id"], h["lon"], h["lat"], h["source"], h["created_at"], h["expires_at"],
    )


async def active_hazards(pool: asyncpg.Pool) -> list[dict]:
    rows = await pool.fetch(
        "SELECT * FROM hazards WHERE cleared_at IS NULL AND expires_at > now() ORDER BY created_at")
    return [dict(r) for r in rows]


async def clear_hazard(pool: asyncpg.Pool, hazard_id, reason: str) -> bool:
    r = await pool.execute(
        "UPDATE hazards SET cleared_at = now(), clear_reason = $2 WHERE id = $1 AND cleared_at IS NULL",
        hazard_id, reason)
    return r.endswith(" 1")


async def insert_demo_reading(pool: asyncpg.Pool, sensor_id: str, depth_cm: float) -> None:
    await pool.execute(
        "INSERT INTO sim_readings (time, sensor_id, depth_cm, source) VALUES (now(), $1, $2, 'demo') "
        "ON CONFLICT DO NOTHING", sensor_id, depth_cm)


async def delete_demo_rows(pool: asyncpg.Pool) -> int:
    r = await pool.execute("DELETE FROM sim_readings WHERE source = 'demo'")
    return int(r.split()[-1])
