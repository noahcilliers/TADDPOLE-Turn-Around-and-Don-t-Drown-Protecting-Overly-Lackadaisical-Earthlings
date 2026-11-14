# FloodRoute: backend handoff

FloodRoute warns drivers in Phoenix, AZ about flooded roads during monsoon flash floods. Sensors at known flood-prone dips report water depth live. The app shows every sensor on a map, warns drivers before they reach a flooded dip, and reroutes them.

This package is everything the frontend design needs from the backend. **Build the backend so that every screen in `screens/` can be driven by real data.**

## What's in here

| Path | What it is |
|---|---|
| `docs/screens.md` | Every screen, what data it shows, which endpoint/event feeds it. Start here. |
| `docs/data-model.md` | Entities, fields, units, statuses. |
| `docs/logic.md` | The rules: status thresholds + hysteresis, rate of rise, offline detection, look-ahead alerts, stalled-car reports, routing around floods, analytics stats, demo mode. |
| `docs/api.md` | REST + realtime contract with example payloads. |
| `api/openapi.yaml` | The same REST contract as OpenAPI 3.1. |
| `db/schema.sql` | Postgres + TimescaleDB schema (Tiger Data). Hypertable for readings, continuous aggregates for charts. |
| `db/load_sample.sql` | Loads the sample data below into that schema. |
| `data/` | Sample data generated from the design prototypes: 7 sensors with GeoJSON, 24 h of per-minute readings, status changes, stats, and the stage-demo timeline. |
| `examples/` | Example JSON for every endpoint and realtime message. |
| `reference/sim.js` | The exact simulation the prototypes run (profiles, thresholds, demo car, alert rule, stats). Runnable with Node, no deps. Use it for demo mode and as a test oracle. |
| `screens/overview_phone.png`, `screens/overview_stage.png` | Contact sheets of every screen. Quickest way to see the whole app. |
| `screens/png/` | Screenshots of every screen and every interactive state (2x). |
| `screens/html/` | Each screen as a standalone HTML file. Open in a browser. `A2-Phone.html` and `A2-Stage.html` are fully clickable prototypes (tap sensors, press Play). A tiny inline runtime renders them; it is reference only, not production frontend code. |
| `screens/design-source/` | The original design-canvas files (`.dc.html`), for the frontend agent if needed. |

## Build order (suggested)

1. **Schema + ingest.** `db/schema.sql`, then `POST /v1/readings` (device key auth). Load `data/` with `db/load_sample.sql`.
2. **Status engine.** On every reading: compute depth, 5-min rate, status (with hysteresis), write `status_changes`, update `sensor_state`. A scheduled job marks sensors offline after 5 min of silence. See `docs/logic.md`.
3. **Read APIs.** `GET /v1/sensors`, `/v1/sensors/{id}`, `/series`, `/stats`, `/status-changes`, `/v1/events`.
4. **Realtime.** WebSocket `/v1/live` (or SSE) pushing `sensor.reading`, `sensor.status_changed`, `hazard.*`, and a heartbeat every 2 s (the UI shows "Live · 2 s ago" and a "Reconnecting / No live data" state).
5. **Hazards.** `POST /v1/hazards` (stalled car), `GET /v1/hazards/active`, `POST /v1/hazards/ahead` (look-ahead check from position + heading).
6. **Routing.** `POST /v1/routes`: fastest + safer alternative, each annotated with the sensors it crosses.
7. **Demo mode.** `POST /v1/demo/*` replays `data/demo_scenario.json` through the real ingest path so the stage demo exercises real code.

## Acceptance checks

- With `data/` loaded and "now" = `2026-08-14T18:40:00-07:00`, `GET /v1/sensors` returns FR-03 `caution`, FR-02 `offline`, the rest `clear` (matches `data/sensors.json`).
- Replaying the demo: FR-07 goes `clear → caution` at demo second 18.5 and `caution → flooded` at 42.1 (real time = demo seconds × 10).
- `GET /v1/sensors/FR-11/stats?range=24h` matches `data/sensor_stats_at_demo_start.json` within rounding.
- `POST /v1/routes` from (2, 3.2) to (2, 0.5) in grid terms (see `data/demo_scenario.json → routes`) returns the safer route once FR-07 is flooded or offline, and flags the original as crossing FR-07.
- A `stalled_vehicle` hazard at FR-07 reaches a driver behind it on 40th St immediately, even if they are more than 1 km away.

## Assumptions to confirm with the team

- Thresholds (10 cm caution, 30 cm flooded, 5 min offline, 1 km look-ahead) are placeholders from the design. They live in one config table.
- Sensor locations are approximations of the real intersections; replace with install coordinates.
- Battery / signal / calibration fields assume the hardware reports them. Drop them if it doesn't.
- The demo date is a stand-in monsoon evening; nothing depends on it.
