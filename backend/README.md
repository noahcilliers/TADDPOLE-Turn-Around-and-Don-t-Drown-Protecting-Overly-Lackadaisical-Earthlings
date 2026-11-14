# Flood Route backend

Sensor readings in Tiger Data → poller → clear / caution / flooded → WebSocket alerts + live rerouting.

```
ESP32 ──► (teammate's writer) ──► Tiger Data: water_levels(time, sensor_id, distance_inches)
                                        │  read-only
                     ┌──────────────────┴─────────────── this service ───────────┐
                     │ poller (1 s): depth = max(0, baseline − distance) via view  │
                     │   median of last 3 + net rise rate (60 s) → classify        │
                     │   → sensor_status, status_events (hypertable)               │
                     │ hub: WS broadcast pins; targeted alerts; OSMnx reroute      │
                     └──────────────────┬──────────────────────────────────────────┘
                                        ▼
                         frontend (Leaflet) over /v1/live + /v1 REST — see API_V1.md (legacy /ws + API.md still work)
```

## Layout

| Path | What |
|---|---|
| `app/main.py` | FastAPI app: REST, `/ws`, admin simulate, lifespan (graph load, migrations, poller task) |
| `app/poller.py` | Poll loop: fill `depth_cm`, classify, persist, push changes |
| `app/status.py` | Pure logic: thresholds, hysteresis, median smoothing, rise rate, alert wording |
| `app/hub.py` | WebSocket clients, per-client routes, targeted alerts, reroutes |
| `app/routing.py` | Road graph, sensor → road-segment snapping (both directions), Dijkstra with closed segments |
| `app/db.py` / `app/migrations.sql` | All SQL. Creates `sensors` (location + dry baseline per sensor), `flood_readings` view (depth in cm), `sensor_status`, `status_events` (hypertable), `water_levels_1m` (continuous aggregate), and seeds `water_tank_1`. Never alters `water_levels` |
| `data/camelback.graphml` | Drivable roads for Arcadia / Camelback East (OSM). Rebuild with `scripts/build_graph.py` |
| `scripts/` | `build_graph.py`, local-dev `local_schema.sql`, `fake_writer.py` (fake ESP32), `ws_client.py` (fake driver) |
| `app/v1.py` | `/v1` REST + `/v1/live` WebSocket for the designed frontend (contract: `API_V1.md`) |
| `app/v1routes.py`, `app/steps.py` | Fastest vs safer routes with `crosses[]` and turn-by-turn steps |
| `app/analytics.py` | Series (120 max-buckets) and stats math for the analytics panel |
| `app/simulator.py` | Replays the handoff's 24 h profiles for 6 simulated sensors into `sim_readings` |
| `app/demo.py` | Stage demo session (play/pause/speed/mode, scripted flood, stalled car) |
| `app/hazards.py`, `app/live.py` | Hazard reports with TTL; `/v1/live` fan-out with 2 s heartbeat |
| `data/readings_24h.csv`, `data/demo_scenario.json` | From the design handoff; drive the simulated sensors and the scripted demo |
| `deploy/` | EC2 bootstrap + rsync deploy |

## Sensors

- `water_tank_1`: the real ESP32 tub sensor (from `water_levels`), placed at 40th St just south of Camelback.
- `FR-02, FR-03, FR-09, FR-11, FR-12, FR-14`: **simulated** (`simulated: true` in the API). They replay the design handoff's 24 h profiles from `sim_readings` and never touch `water_levels`. Delete their rows from `sensors` to hide them.
- Status adds **offline**: no reading for `OFFLINE_AFTER_S` (300 s). Routing avoids offline sensors by default.

## Stage demo (`/v1/demo/*`, needs `X-Admin-Token`)

Play/pause/speed/mode are shared by every connected screen. **Scripted flood** replaces `water_tank_1`'s real readings with the handoff's depth curve, as a fallback if the tub misbehaves. **Stall** drops a stalled-car hazard at 40th St. **Reset** puts everything back.

## Status rules (all env-tunable — see `.env.example`)

- **flooded**: smoothed depth ≥ 15 cm (`FLOODED_CM`)
- **caution**: depth ≥ 5 cm (`CAUTION_CM`) **or** rising ≥ 2 cm/min over the last 60 s
- **clear**: otherwise
- Smoothed depth = median of last 3 readings. Downgrades need depth 2 cm below the threshold (hysteresis).
- No data for 60 s → pin flagged `stale` (legacy API); none for 300 s → status `offline`.
- History charts and stats (`/v1/sensors/{id}/series`, `/stats`) run raw readings through a Hampel spike filter (`app/filters.py`) before taking the per-bucket max, so a single bad echo or dropout never shows up as a peak. Tune with `SPIKE_HALF_WINDOW`, `SPIKE_SIGMAS`, `SPIKE_MIN_CM`.

For a tub-of-water demo, lower these (e.g. `CAUTION_CM=2 FLOODED_CM=5`) to match your tub depth.

## Run locally

```bash
cd backend
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements-dev.txt
docker compose -f docker-compose.dev.yml up -d          # local TimescaleDB with a water_levels table
# DATABASE_URL in the shell overrides TIGER_DB in .env, so this hits the local DB:
DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres ADMIN_TOKEN=devtoken .venv/bin/uvicorn app.main:app --reload
```

Fake a driver and a flood in two more terminals:

```bash
.venv/bin/python scripts/ws_client.py --from 33.5050,-111.9953 --to 33.5160,-111.9953
.venv/bin/python scripts/fake_writer.py --sensor water_tank_1 --ramp 0 25 20
```

Tests: `.venv/bin/python -m pytest`

## Tiger Data

`.env` holds `TIGER_DB=postgres://tsdbadmin:<password>@…?sslmode=require` (`DATABASE_URL` also works). Run with plain `.venv/bin/uvicorn app.main:app`.

The writer's table is `water_levels(time, sensor_id, distance_inches)`; the backend only reads it (plus the admin simulate endpoint, which inserts a row the same way the ESP32 does). Everything the writer doesn't know lives in the backend's `sensors` table:

```sql
-- calibrate: distance from the sensor to the dry road/tub bottom, in inches
UPDATE sensors SET baseline_cm = 33.2 * 2.54 WHERE sensor_id = 'water_tank_1';
-- add another sensor (any sensor_id the writer sends)
INSERT INTO sensors VALUES ('wash_hayden', 'Hayden Rd wash', 33.5..., -111.9..., 40 * 2.54);
```

Changes are picked up within 30 s, no restart. `water_tank_1` has a measured **24 in baseline** (dry distance; depth = 24 in − reading) and sits on 40th St just south of Camelback. Put sensors on the road at the dip, not the intersection centre; the log prints how far each snapped (warns > 75 m) and warns about `sensor_id`s in `water_levels` with no `sensors` row.

`water_levels` primary key is `(sensor_id, time)` (changed from `time` alone on 2026-11-14 via `scripts/tiger/001_water_levels_pk.sql`, so multiple sensors can report at the same instant; the writer needed no change). Writer tip: send a reading every 1–2 s; with median-of-3 smoothing, latency is about 2 readings.

## Deploy (single EC2 + docker compose + Caddy)

One instance on purpose: a second copy would double-poll and split WebSocket clients.
Caddy serves the built frontend (`../frontend/Dockerfile`) and proxies `/v1`, `/ws` and the legacy API to the `api` container on the **same origin**.

1. Launch Amazon Linux 2023, t3.small, attach an Elastic IP. Security group: 22 (your IP), 80, 443.
2. Copy `deploy/ec2-bootstrap.sh` up and run it (or paste it as user data).
3. Domain: point an A record (e.g. `turnarounddontdrown.tech`) at the Elastic IP and set `SITE_ADDRESS` to it in `.env`; Caddy gets the TLS cert. Phones need HTTPS for GPS and `wss://`. Without a domain it serves plain HTTP on the IP.
4. Set `ADMIN_TOKEN` in `.env` (demo controls), then `scp .env ec2-user@<ip>:/opt/floodroute/backend/.env`
5. `HOST=ec2-user@<ip> KEY=~/.ssh/<key>.pem ./deploy/deploy.sh` (syncs `backend/` and `frontend/`, builds both images)
6. Open `https://<domain>/?demo_key=<ADMIN_TOKEN>` on the presenter laptop; `https://<domain>/health` for status.
