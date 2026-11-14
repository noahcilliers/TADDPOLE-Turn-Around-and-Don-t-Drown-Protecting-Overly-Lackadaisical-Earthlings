-- Idempotent; runs on every startup.
-- Source of truth for raw data is the team's `water_levels(time, sensor_id, distance_inches)`
-- hypertable. This file never alters it: everything below is owned by the backend.

-- Sensor metadata the writer doesn't store: where each sensor is and its dry-road distance.
CREATE TABLE IF NOT EXISTS sensors (
    sensor_id    TEXT PRIMARY KEY,                 -- same string the ESP32 writes to water_levels
    name         TEXT NOT NULL,                    -- '40th St & Camelback'
    lat          DOUBLE PRECISION NOT NULL,
    lon          DOUBLE PRECISION NOT NULL,
    baseline_cm  REAL                              -- distance to the dry road (NULL = not calibrated)
);

-- Current status per sensor (survives restarts; frontend can read it directly).
CREATE TABLE IF NOT EXISTS sensor_status (
    sensor_id        TEXT PRIMARY KEY REFERENCES sensors(sensor_id) ON DELETE CASCADE,
    status           TEXT NOT NULL CHECK (status IN ('clear', 'caution', 'flooded')),
    depth_cm         REAL,
    rise_cm_per_min  REAL,
    changed_at       TIMESTAMPTZ NOT NULL,   -- last status transition
    updated_at       TIMESTAMPTZ NOT NULL    -- last evaluation
);

-- Every status transition, for a history / timeline view.
CREATE TABLE IF NOT EXISTS status_events (
    time             TIMESTAMPTZ NOT NULL,
    sensor_id        TEXT NOT NULL,
    prev_status      TEXT,
    status           TEXT NOT NULL,
    depth_cm         REAL,
    rise_cm_per_min  REAL
);
SELECT create_hypertable('status_events', by_range('time'), if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS status_events_sensor_time_idx ON status_events (sensor_id, time DESC);

-- Per-minute distance rollup for charts. Stores raw distance (not depth) so a baseline
-- change never leaves stale depths baked into materialized buckets; the API converts.
-- Real-time: includes the not-yet-materialized tail.
CREATE MATERIALIZED VIEW IF NOT EXISTS water_levels_1m
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 minute', time) AS bucket,
       sensor_id,
       avg(distance_inches) AS avg_distance_in,
       min(distance_inches) AS min_distance_in,   -- closest water surface = deepest moment
       count(*)             AS n
  FROM water_levels
 GROUP BY bucket, sensor_id
WITH NO DATA;

ALTER MATERIALIZED VIEW water_levels_1m SET (timescaledb.materialized_only = false);

SELECT add_continuous_aggregate_policy('water_levels_1m',
    start_offset      => INTERVAL '1 day',
    end_offset        => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists     => TRUE);

-- Demo sensor. Placeholder baseline 26.7 in (67.8 cm) until the dry distance is measured:
--   UPDATE sensors SET baseline_cm = <dry_inches> * 2.54 WHERE sensor_id = 'water_tank_1';
-- DO NOTHING: never overwrites a location/baseline someone has already set.
INSERT INTO sensors (sensor_id, name, lat, lon, baseline_cm)
VALUES ('water_tank_1', '40th St & Camelback', 33.5110, -111.9953, 26.7 * 2.54)
ON CONFLICT (sensor_id) DO NOTHING;

-- ======================= v1 additions (frontend handoff) =======================

-- Extra sensor metadata. Nullable: the real sensor doesn't report battery/signal.
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS road          TEXT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS simulated     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS battery_pct   SMALLINT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS signal        TEXT;
ALTER TABLE sensors ADD COLUMN IF NOT EXISTS calibrated_at DATE;

-- Move the demo sensor onto 40th St just SOUTH of Camelback (the handoff's FR-07 dip),
-- but only if nobody has repositioned it since the original seed.
UPDATE sensors
   SET lat = 33.5085, lon = -111.99532, road = 'N 40th St dip, south of Camelback Rd'
 WHERE sensor_id = 'water_tank_1' AND lat = 33.5110 AND lon = -111.9953;
UPDATE sensors SET road = 'N 40th St dip, south of Camelback Rd'
 WHERE sensor_id = 'water_tank_1' AND road IS NULL;

-- Six simulated sensors from the design handoff (FR-07 is replaced by the real water_tank_1).
INSERT INTO sensors (sensor_id, name, road, lat, lon, baseline_cm, simulated, battery_pct, signal, calibrated_at) VALUES
  ('FR-03', '32nd St & Indian School', 'Indian School Rd low point at 32nd St', 33.49492, -112.01266, NULL, TRUE, 74, 'good', DATE '2026-05-30'),
  ('FR-11', '44th St & Thomas', 'Thomas Rd dip east of 44th St', 33.48043, -111.98665, NULL, TRUE, 91, 'strong', DATE '2026-06-12'),
  ('FR-09', '36th St & Thomas', 'Thomas Rd wash crossing at 36th St', 33.48043, -112.00399, NULL, TRUE, 68, 'good', DATE '2026-05-30'),
  ('FR-02', '32nd St & Camelback', '32nd St dip north of Camelback Rd', 33.50941, -112.01266, NULL, TRUE, 9, 'lost', DATE '2026-04-18'),
  ('FR-12', '44th St & Campbell', '44th St dip at Campbell Ave', 33.502165, -111.98665, NULL, TRUE, 80, 'strong', DATE '2026-06-12'),
  ('FR-14', '40th St & McDowell', 'McDowell Rd low point at 40th St', 33.46594, -111.99532, NULL, TRUE, 77, 'good', DATE '2026-06-02')
ON CONFLICT (sensor_id) DO NOTHING;

-- Readings that don't come from hardware: replayed profiles (FR-xx) and the scripted demo flood.
CREATE TABLE IF NOT EXISTS sim_readings (
    time       TIMESTAMPTZ NOT NULL,
    sensor_id  TEXT NOT NULL,
    depth_cm   REAL NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('profile', 'demo')),
    PRIMARY KEY (sensor_id, source, time)
);
SELECT create_hypertable('sim_readings', by_range('time'), if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS sim_state (
    key    TEXT PRIMARY KEY,
    value  TIMESTAMPTZ NOT NULL
);

-- One stream of depths for every sensor, tagged by where it came from.
DROP VIEW IF EXISTS flood_readings;
CREATE VIEW flood_readings AS
SELECT w.time,
       w.sensor_id,
       GREATEST(0, s.baseline_cm - w.distance_inches * 2.54) AS depth_cm,
       'device'::text                                         AS source
  FROM water_levels w
  JOIN sensors s USING (sensor_id)
UNION ALL
SELECT r.time, r.sensor_id, r.depth_cm, r.source
  FROM sim_readings r;

-- 'offline' is a real status now.
ALTER TABLE sensor_status DROP CONSTRAINT IF EXISTS sensor_status_status_check;
ALTER TABLE sensor_status ADD CONSTRAINT sensor_status_status_check
    CHECK (status IN ('clear', 'caution', 'flooded', 'offline'));

-- Driver / operator / demo reports that aren't sensor readings.
CREATE TABLE IF NOT EXISTS hazards (
    id            UUID PRIMARY KEY,
    kind          TEXT NOT NULL,
    sensor_id     TEXT REFERENCES sensors(sensor_id) ON DELETE SET NULL,
    lon           DOUBLE PRECISION NOT NULL,
    lat           DOUBLE PRECISION NOT NULL,
    source        TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    cleared_at    TIMESTAMPTZ,
    clear_reason  TEXT
);
CREATE INDEX IF NOT EXISTS hazards_active_idx ON hazards (expires_at) WHERE cleared_at IS NULL;
