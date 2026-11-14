-- FloodRoute schema for Postgres + TimescaleDB (Tiger Data).
-- PostGIS is optional; segments are stored as GeoJSON jsonb so this runs without it.
-- If PostGIS is available, swap the jsonb columns for geometry(Point,4326) / geometry(LineString,4326)
-- and use ST_DWithin for route crossings and look-ahead queries.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TYPE sensor_status AS ENUM ('clear', 'caution', 'flooded', 'offline');
CREATE TYPE hazard_kind   AS ENUM ('stalled_vehicle', 'road_closed', 'debris');
CREATE TYPE data_source   AS ENUM ('device', 'driver', 'operator', 'demo');

-- Tunable rules (one row). Everything in docs/logic.md reads from here.
CREATE TABLE config (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  caution_cm              real    NOT NULL DEFAULT 10,
  flooded_cm              real    NOT NULL DEFAULT 30,
  rising_fast_cm_per_min  real    NOT NULL DEFAULT 1.0,
  rising_fast_min_cm      real    NOT NULL DEFAULT 5,
  hysteresis_cm           real    NOT NULL DEFAULT 2,
  hysteresis_hold_s       int     NOT NULL DEFAULT 120,
  offline_after_s         int     NOT NULL DEFAULT 300,
  lookahead_m             int     NOT NULL DEFAULT 1000,
  lookahead_half_angle    int     NOT NULL DEFAULT 20,
  stalled_alert_m         int     NOT NULL DEFAULT 2500,
  hazard_ttl_min          int     NOT NULL DEFAULT 30
);
INSERT INTO config DEFAULT VALUES;

CREATE TABLE sensors (
  id             text PRIMARY KEY,                 -- e.g. 'FR-07'
  name           text NOT NULL,                    -- '40th St & Camelback'
  road           text NOT NULL,
  location       jsonb NOT NULL,                   -- GeoJSON Point [lng,lat]
  segment        jsonb NOT NULL,                   -- GeoJSON LineString
  lng            double precision GENERATED ALWAYS AS ((location->'coordinates'->>0)::double precision) STORED,
  lat            double precision GENERATED ALWAYS AS ((location->'coordinates'->>1)::double precision) STORED,
  device_key_hash text,
  battery_pct    smallint,
  signal         text CHECK (signal IN ('strong','good','weak','lost')),
  calibrated_at  date,
  installed_at   timestamptz DEFAULT now()
);

-- Raw readings: hypertable.
CREATE TABLE readings (
  time        timestamptz NOT NULL,
  sensor_id   text        NOT NULL REFERENCES sensors(id),
  depth_cm    real        NOT NULL CHECK (depth_cm >= 0 AND depth_cm < 500),
  battery_pct smallint,
  rssi_dbm    smallint,
  source      data_source NOT NULL DEFAULT 'device',
  PRIMARY KEY (sensor_id, time)
);
SELECT create_hypertable('readings', 'time', chunk_time_interval => interval '1 day');
CREATE INDEX ON readings (sensor_id, time DESC);
ALTER TABLE readings SET (timescaledb.compress, timescaledb.compress_segmentby = 'sensor_id');
SELECT add_compression_policy('readings', interval '7 days');
SELECT add_retention_policy('readings', interval '400 days');

-- 1-minute aggregate: drives rate of rise, 1h/6h charts, stats.
CREATE MATERIALIZED VIEW readings_1m
WITH (timescaledb.continuous) AS
SELECT sensor_id,
       time_bucket('1 minute', time) AS bucket,
       max(depth_cm) AS max_cm,
       avg(depth_cm) AS avg_cm,
       last(depth_cm, time) AS last_cm,
       count(*) AS n
FROM readings
GROUP BY sensor_id, bucket
WITH NO DATA;
SELECT add_continuous_aggregate_policy('readings_1m',
  start_offset => interval '2 days', end_offset => interval '1 minute', schedule_interval => interval '30 seconds');
ALTER MATERIALIZED VIEW readings_1m SET (timescaledb.materialized_only = false); -- real-time aggregation

-- 10-minute aggregate: 24h charts and longer history.
CREATE MATERIALIZED VIEW readings_10m
WITH (timescaledb.continuous) AS
SELECT sensor_id,
       time_bucket('10 minutes', time) AS bucket,
       max(depth_cm) AS max_cm,
       avg(depth_cm) AS avg_cm
FROM readings
GROUP BY sensor_id, bucket
WITH NO DATA;
SELECT add_continuous_aggregate_policy('readings_10m',
  start_offset => interval '7 days', end_offset => interval '10 minutes', schedule_interval => interval '5 minutes');
ALTER MATERIALIZED VIEW readings_10m SET (timescaledb.materialized_only = false);

-- Current state per sensor (written by the status engine on every reading / offline sweep).
CREATE TABLE sensor_state (
  sensor_id        text PRIMARY KEY REFERENCES sensors(id),
  status           sensor_status NOT NULL DEFAULT 'offline',
  depth_cm         real,
  rate_cm_per_min  real,
  last_reading_at  timestamptz,
  status_since     timestamptz NOT NULL DEFAULT now(),
  pending_downgrade_since timestamptz          -- hysteresis bookkeeping
);

CREATE TABLE status_changes (
  time         timestamptz NOT NULL,
  sensor_id    text NOT NULL REFERENCES sensors(id),
  from_status  sensor_status NOT NULL,
  to_status    sensor_status NOT NULL,
  depth_cm     real,
  source       data_source NOT NULL DEFAULT 'device',
  PRIMARY KEY (sensor_id, time)
);
SELECT create_hypertable('status_changes', 'time', chunk_time_interval => interval '30 days');
CREATE INDEX ON status_changes (time DESC);

CREATE TABLE hazards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        hazard_kind NOT NULL,
  location    jsonb NOT NULL,                     -- GeoJSON Point
  sensor_id   text REFERENCES sensors(id),
  source      data_source NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  cleared_at  timestamptz
);
CREATE INDEX ON hazards (expires_at) WHERE cleared_at IS NULL;

CREATE TABLE demo_session (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  state     text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','playing','paused')),
  mode      text NOT NULL DEFAULT 'nav'  CHECK (mode IN ('nav','watch')),
  speed     real NOT NULL DEFAULT 2,
  demo_s    real NOT NULL DEFAULT 0,
  stall_at  real,
  started_at timestamptz
);
INSERT INTO demo_session DEFAULT VALUES;

-- ---------------------------------------------------------------- handy queries

-- 5-minute rate of rise for one sensor (cm/min)
-- SELECT (a.last_cm - b.last_cm) / 5 AS rate
-- FROM readings_1m a JOIN readings_1m b USING (sensor_id)
-- WHERE a.sensor_id = $1 AND a.bucket = time_bucket('1 minute', now()) AND b.bucket = a.bucket - interval '5 minutes';

-- Chart series: 120 max-buckets over a range, gaps kept
-- SELECT time_bucket_gapfill(($range / 120), bucket) AS t, max(max_cm) AS depth_cm
-- FROM readings_1m
-- WHERE sensor_id = $1 AND bucket > now() - $range AND bucket <= now()
-- GROUP BY t ORDER BY t;

-- Stats over a range
-- SELECT max(max_cm) AS peak_cm,
--        (array_agg(bucket ORDER BY max_cm DESC))[1] AS peak_at,
--        count(*) FILTER (WHERE max_cm >= 10) AS minutes_above_caution,
--        count(*) FILTER (WHERE max_cm >= 30) AS minutes_flooded
-- FROM readings_1m WHERE sensor_id = $1 AND bucket > now() - $range;
