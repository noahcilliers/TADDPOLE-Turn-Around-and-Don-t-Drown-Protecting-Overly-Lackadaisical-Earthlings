# FloodRoute

Live flood warnings and rerouting for drivers in Phoenix, AZ, built at SunHacks.

Water-level sensors sit at flood-prone road dips. When a sensor reports rising water, its pin on the map turns yellow, then red. Drivers headed for that dip get an alert and a new route around it. The demo covers Arcadia / Camelback East, including the 40th St & Camelback dip.

```
ESP32 sensor ──► Tiger Data (TimescaleDB): water_levels
                         │
                         ▼
        backend/  FastAPI: poll → classify clear / caution / flooded / offline
                  → WebSocket alerts + local road-graph rerouting (OSMnx)
                         │  /v1 REST + /v1/live WebSocket
                         ▼
        frontend/ React + Leaflet map, driver and stage screens
```

## Repo layout

| Path | What |
|---|---|
| [`backend/`](backend/) | FastAPI service: poller, status engine, routing, hazards, demo mode. See [backend/README.md](backend/README.md). |
| [`backend/API_V1.md`](backend/API_V1.md) | The `/v1` REST and WebSocket contract the frontend uses. |
| [`frontend/`](frontend/) | React 19 + Vite + Leaflet app. |
| [`handoff/floodroute-handoff/`](handoff/floodroute-handoff/) | Design handoff: screens, data model, logic rules, sample data, OpenAPI spec. |
| [`docs/`](docs/) | Planning notes: map & routing plan, DB schema notes, SunHacks brief. |

## Quick start

You need Python 3.12, Node 20+, and Docker (for a local TimescaleDB).

**Backend** (port 8000):

```bash
cd backend
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements-dev.txt
docker compose -f docker-compose.dev.yml up -d
DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres ADMIN_TOKEN=devtoken .venv/bin/uvicorn app.main:app --reload
```

To use Tiger Data instead of the local database, copy `backend/.env.example` to `backend/.env` and fill in `DATABASE_URL`.

**Frontend** (port 5173, proxies `/v1` to the backend):

```bash
cd frontend
npm install
npm run dev
```

Set `BACKEND_URL` to point the dev proxy at a different backend, or `VITE_API_BASE` to call one directly from the browser.

**Fake a flood** (with the backend running):

```bash
cd backend
.venv/bin/python scripts/fake_writer.py --sensor water_tank_1 --ramp 0 25 20
```

## Sensors and status

- `water_tank_1` is the real ESP32 sensor. Six more (`FR-02`, `FR-03`, `FR-09`, `FR-11`, `FR-12`, `FR-14`) are simulated and replay 24 h profiles from the design handoff.
- **caution**: depth ≥ 5 cm, or rising ≥ 2 cm/min. **flooded**: depth ≥ 15 cm. **offline**: no reading for 5 min.
- Thresholds are set by env vars; see `backend/.env.example`.

## Tests

```bash
cd backend && .venv/bin/python -m pytest
```

## Deploy

One EC2 instance running docker compose with Caddy for HTTPS. Steps are in [backend/README.md](backend/README.md#deploy-single-ec2--docker-compose--caddy).
