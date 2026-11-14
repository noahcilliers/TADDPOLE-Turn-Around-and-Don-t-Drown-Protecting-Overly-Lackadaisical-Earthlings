-- One-off change to the team's water_levels table (applied to Tiger Data 2026-11-14).
-- Primary key (time) -> (sensor_id, time) so two sensors can report at the same instant.
-- Writer is unaffected: it does a plain INSERT (time, sensor_id, distance_inches) with no ON CONFLICT.
-- Idempotent: only acts if the key is still on (time) alone.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'water_levels'::regclass AND contype = 'p') = 'PRIMARY KEY ("time")' THEN
    ALTER TABLE water_levels DROP CONSTRAINT water_levels_pkey;
    ALTER TABLE water_levels ADD CONSTRAINT water_levels_pkey PRIMARY KEY (sensor_id, time);
  END IF;
END $$;
COMMIT;
