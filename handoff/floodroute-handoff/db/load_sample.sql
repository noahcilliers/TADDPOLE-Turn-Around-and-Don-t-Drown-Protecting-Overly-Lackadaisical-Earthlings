-- Load the sample data in ../data into the schema. Run from the package root with psql:
--   psql "$DATABASE_URL" -f db/schema.sql
--   psql "$DATABASE_URL" -f db/load_sample.sql
-- Sensors come from data/sensors.json; this file inlines them so no JSON tooling is needed.

INSERT INTO sensors (id, name, road, location, segment, battery_pct, signal, calibrated_at) VALUES
('FR-07','40th St & Camelback','N 40th St dip, south of Camelback Rd','{"type":"Point","coordinates":[-111.99532,33.50941]}','{"type":"LineString","coordinates":[[-111.99532,33.512018],[-111.99532,33.506222]]}',86,'strong','2026-06-12'),
('FR-03','32nd St & Indian School','Indian School Rd low point at 32nd St','{"type":"Point","coordinates":[-112.01266,33.49492]}','{"type":"LineString","coordinates":[[-112.016128,33.49492],[-112.009192,33.49492]]}',74,'good','2026-05-30'),
('FR-11','44th St & Thomas','Thomas Rd dip east of 44th St','{"type":"Point","coordinates":[-111.98665,33.48043]}','{"type":"LineString","coordinates":[[-111.990118,33.48043],[-111.983182,33.48043]]}',91,'strong','2026-06-12'),
('FR-09','36th St & Thomas','Thomas Rd wash crossing at 36th St','{"type":"Point","coordinates":[-112.00399,33.48043]}','{"type":"LineString","coordinates":[[-112.007458,33.48043],[-112.000522,33.48043]]}',68,'good','2026-05-30'),
('FR-02','32nd St & Camelback','32nd St dip north of Camelback Rd','{"type":"Point","coordinates":[-112.01266,33.50941]}','{"type":"LineString","coordinates":[[-112.01266,33.512308],[-112.01266,33.506512]]}',9,'lost','2026-04-18'),
('FR-12','44th St & Campbell','44th St dip at Campbell Ave','{"type":"Point","coordinates":[-111.98665,33.502165]}','{"type":"LineString","coordinates":[[-111.98665,33.504773],[-111.98665,33.499557]]}',80,'strong','2026-06-12'),
('FR-14','40th St & McDowell','McDowell Rd low point at 40th St','{"type":"Point","coordinates":[-111.99532,33.46594]}','{"type":"LineString","coordinates":[[-111.998788,33.46594],[-111.991852,33.46594]]}',77,'good','2026-06-02');

\copy readings (time, sensor_id, depth_cm) FROM 'data/readings_24h.csv' WITH (FORMAT csv, HEADER true);

-- Status changes are normally produced by the status engine; this seeds them for UI work.
-- (Load data/status_changes_24h.json with your app code, or let the engine recompute from readings.)

CALL refresh_continuous_aggregate('readings_1m', NULL, NULL);
CALL refresh_continuous_aggregate('readings_10m', NULL, NULL);
