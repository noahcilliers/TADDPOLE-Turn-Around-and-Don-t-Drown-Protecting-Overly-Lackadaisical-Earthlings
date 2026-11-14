-- LOCAL DEV ONLY: recreates the team's real Tiger Data table so the backend can run
-- against a Docker TimescaleDB. Do NOT run against Tiger Data.
-- (The backend's own migrations create `sensors`, the status tables and the demo sensor.)
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS water_levels (
    time             TIMESTAMPTZ NOT NULL,
    sensor_id        TEXT NOT NULL,
    distance_inches  DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (sensor_id, time)   -- matches Tiger Data after scripts/tiger/001_water_levels_pk.sql
);
SELECT create_hypertable('water_levels', by_range('time'), if_not_exists => TRUE);
