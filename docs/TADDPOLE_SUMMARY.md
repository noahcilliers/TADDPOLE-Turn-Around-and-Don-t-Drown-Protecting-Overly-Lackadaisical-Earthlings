# TADDPOLE: what we built and how it runs

*Turn Around and Don't Drown: Protecting Overly Lackadaisical Earthlings.* It started as "FloodRoute", built at SunHacks on Nov 14, 2026. That name still shows up in paths like `/opt/floodroute` and `handoff/floodroute-handoff/`.

_Summary written Nov 15, 2026. Live-site and test details below were checked that day._

## What it does

TADDPOLE warns drivers in Phoenix about flooded roads and reroutes them around the water as it happens. Water-level sensors sit at road dips that tend to flood. As water rises, a sensor's pin goes from clear to yellow (caution) to red (flooded). Any driver whose route crosses that dip gets an alert and a new route, with no button press needed.

- **Demo area:** Arcadia / Camelback East, centred on the 40th St & Camelback dip.
- **Live site:** https://ifyourreadingthisimstranded.us. On Nov 15, `/health` was OK, routing was loaded and the camera check was on.
- **Mascot:** a blue frog in a yellow raincoat. It's the car marker, the "O" in the logo, the favicon and the recenter button.

## How data flows through it

```
Ultrasonic sensor in a tub ──serial──► Python logger on a laptop
                                         │ INSERT every 2 s
                                         ▼
                         Tiger Data (TimescaleDB): water_levels
                                         │ backend polls it every 1 s (read-only)
Laptop webcam ─► camera_server.py ─► cloudflared tunnel
                                         ▼
          FastAPI backend on EC2 (docker compose + Caddy for HTTPS)
            poll → smooth → classify → camera/Gemini "is it water?" check
            → WebSocket push · Discord alert · road-graph rerouting
                                         │ /v1 REST + /v1/live WebSocket
                                         ▼
          React 19 + Vite + Leaflet frontend
            Stage layout (laptop/projector) · Phone layout (judges)
```

## 1. Hardware and logger

- **What it is:** an Arduino/ESP32 ultrasonic sensor mounted above a tub measures the distance down to the water. A Python logger reads the serial port and writes `(time, sensor_id, distance_inches)` into Tiger Data every 2 s.
- **Where the code is:** the logger lives in [arduino/sensor.ino](../arduino/sensor.ino). Despite the `.ino` extension, that file is the Python logger, not Arduino firmware.
- **Settings:** the sensor ID is hardcoded as `water_tank_1`. The port defaults to `COM3`, so on a Mac change it to `/dev/cu.usbmodem*`.
- **Depth:** depth = baseline − distance. The baseline is the distance to the dry tub bottom, 24 in.

## 2. Database (Tiger Data / TimescaleDB)

- **Logger-owned:** `water_levels`. The backend only reads it, except for the admin "simulate" endpoint. Its primary key was changed to `(sensor_id, time)` so several sensors can report at the same instant.
- **Backend-owned tables:**
  - `sensors`: name, lat/lon and baseline per sensor.
  - `flood_readings`: a view that converts inches to depth in cm.
  - `sensor_status` and `status_events`: current status and history.
  - `water_levels_1m`: per-minute summaries for charts.
  - Simulated readings table: replay data for the fake sensors.
- **Setup:** these are created on startup by [migrations.sql](../backend/app/migrations.sql).
- **Sensors:** one real sensor (`water_tank_1`) and six simulated ones (`FR-02/03/09/11/12/14`). The simulated ones replay 24-hour profiles from the design handoff.

## 3. Backend (`backend/app/`, FastAPI + asyncpg)

| Module | Job |
|---|---|
| [poller.py](../backend/app/poller.py) | Runs every 1 s: reads depths, classifies them, saves status changes, pushes updates |
| [status.py](../backend/app/status.py) | The status rules (below) |
| [filters.py](../backend/app/filters.py) | Spike filter so one bad echo never shows up as a peak on charts or stats |
| [camera.py](../backend/app/camera.py) | Gemini check that gates escalations (below) |
| [routing.py](../backend/app/routing.py), [v1routes.py](../backend/app/v1routes.py), [steps.py](../backend/app/steps.py) | Routing on a local road graph built from OpenStreetMap (`data/camelback.graphml`): fastest vs safer route, plus turn-by-turn steps |
| [hub.py](../backend/app/hub.py), [live.py](../backend/app/live.py) | WebSocket fan-out (`/v1/live`, 2 s heartbeat) |
| [demo.py](../backend/app/demo.py) | One shared demo clock that every connected screen follows; scripted 124 s flood curve |
| [simulator.py](../backend/app/simulator.py), [hazards.py](../backend/app/hazards.py), [analytics.py](../backend/app/analytics.py) | Simulated sensors, stalled-car hazards, chart and stats math |
| [discord_alerts.py](../backend/app/discord_alerts.py) | Discord webhook posts on flooded/reopened, `@everyone` on flooded, 60 s cooldown |

### Status rules

All adjustable through env vars (see `backend/.env.example`):

- **Flooded:** depth ≥ 15 cm.
- **Caution:** depth ≥ 5 cm, or rising ≥ 2 cm/min.
- **Offline:** no reading for 5 min.
- Depth is smoothed as the median of the last 3 readings. A status only drops back down once depth is 2 cm below the threshold.

### Routing

- The flooded road segment is blocked outright.
- Roads within 300 m of it cost 40× more, and a softer penalty extends out to 700 m.
- Roads near caution sensors cost 2×; roads near clear sensors get a small discount.
- A car already inside the zone can still route out.

### Camera check

- Before a status goes **up**, the backend grabs a webcam photo and asks Gemini whether there's really water under the sensor.
- If it sees an object (a hand, a toy car, a bottle), it holds the old status, so no alert, Discord post or reroute fires. It looks again every 10 s.
- If the camera or Gemini fails, it lets the alert through anyway ("fails open"), since a missed flood is worse than a false one.
- Going **down** is never checked, and the scripted demo skips the check.
- On Nov 15 the live `/health` showed it holding back an alert for `water_tank_1` because Gemini saw a plastic bottle sticking out of the water.
- Debug: `GET /health` → `camera`; last photo judged: `GET /camera/water_tank_1/last.jpg`.

### API

Full contract in [API_V1.md](../backend/API_V1.md).

- **Public:** sensors, series, stats, events, routes, hazards, demo state, `WS /v1/live`.
- **Admin (needs the `X-Admin-Token` header):** demo start/pause/speed/mode/reset, simulate a reading, Discord test. Admin routes return 404 if `ADMIN_TOKEN` is unset.

## 4. Frontend (`frontend/src/`, React 19 + Vite + Leaflet)

Built from the 18-screen design handoff in `handoff/floodroute-handoff/`. It uses no paid map services: OpenStreetMap tiles (greyed out) and Nominatim for address search.

- **Stage layout (≥1024 px, or `?view=stage`):**
  - A resizable left panel with the logo and three tabs: Sensor analytics, All sensors, Alerts.
  - The map, a legend and a demo panel.
  - The demo panel offers Automatic flood vs Live sensor, Play/Reset and Speed. It unlocks once per device with `?demo_key=<ADMIN_TOKEN>`.
- **Phone layout (or `?view=phone`):** opens straight to Drive, with tabs Sensors · Drive · Alerts. It has no demo controls.
- **Drive engine ([drive.tsx](../frontend/src/drive.tsx)):**
  - The car moves step by step and stops about 90 m before any flooded dip.
  - When a flood lands on the route, it shows "Flooded ahead · Rerouting…", then about 1.5 s later "Rerouted around flooding · +N min".
  - If no flood-free route exists, it holds in place and retries every 8 s.
- **Map ([FloodMap.tsx](../frontend/src/components/FloodMap.tsx)):**
  - The map keeps following the frog. Dragging the map stops that; the frog button turns it back on.
  - The frog's heading is smoothed so it doesn't jitter.
  - Mac trackpad pinch-zoom is handled by [trackpadPinch.ts](../frontend/src/components/trackpadPinch.ts).
- **Live connection ([store.ts](../frontend/src/store.ts)):** WebSocket with a 10 s watchdog, and it reconnects with backoff if the connection drops.
- **Sounds:** a two-note chime when flooding is on your route, and a soft chime on arrival, both generated with Web Audio. (See "What needs attention": this code is not on `main` yet.)

## 5. Deployment

- **Server:** one AWS EC2 t3.small in Ohio running two containers, `api` and `caddy`. Caddy serves the built frontend, proxies the API and WebSocket on the same domain, and handles the HTTPS certificate automatically.
- **Why only one:** a second copy would poll twice and send duplicate Discord alerts.
- **Domain:** `ifyourreadingthisimstranded.us` (Porkbun), pointed at Elastic IP `3.134.144.194`.
- **Deploy:** this copies the local `backend/` and `frontend/` folders to the server and rebuilds. It ships whatever is on disk in the folder you run it from, and leaves the server's `.env` alone.

  ```bash
  cd /Users/noahcilliers/UNSTUCK/backend && HOST=ec2-user@ifyourreadingthisimstranded.us KEY=~/.ssh/taddpole.pem ./deploy/deploy.sh
  ```

- **Server config:** `/opt/floodroute/backend/.env`. After an `.env`-only change, run `docker compose up -d api` on the server.
- **Camera in production:** EC2 has no webcam. The laptop runs `scripts/camera_server.py` behind a `cloudflared` tunnel. The tunnel URL changes every restart, so `CAMERA` in the server's `.env` has to be updated each time. Keep the laptop awake with `caffeinate -d`.

## 6. Running it locally

Start a throwaway local database:

```bash
cd backend && docker compose -f docker-compose.dev.yml up -d
```

Start the backend on port 8000:

```bash
cd backend && DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres ADMIN_TOKEN=devtoken .venv/bin/uvicorn app.main:app --reload
```

Start the frontend on :5173 (it proxies `/v1` to the backend):

```bash
npm --prefix frontend run dev
```

Fake a flood:

```bash
cd backend && .venv/bin/python scripts/fake_writer.py --sensor water_tank_1 --ramp 0 25 20
```

Don't run a local backend against Tiger Data while EC2 is running: both would write status history and post to Discord.

**Tests:** all 78 backend tests passed on Nov 15 (`cd backend && .venv/bin/python -m pytest`). There are no frontend tests.

## What needs attention

- **Alert sounds aren't on `main`:**
  - `sounds.ts` exists only on branch `claude/arrived-flood-alert-sounds-1f23e1`, in commit `60b87c1`.
  - The live site has it, but a deploy from `main` would remove it.
  - [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) says it was merged; that's wrong.
- **[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) is stale and untracked:**
  - It's a detailed write-up of everything built during SunHacks, but git isn't tracking it.
  - It still lists the camera work as uncommitted, but that's commit `7591552` on `main`.
- **Security clean-up after the hackathon:**
  - Rotate the Tiger database password and the Discord webhook URL; both were pasted into chat.
  - Restrict SSH on the server, which is currently open to any IP (`0.0.0.0/0`).
  - `POST /v1/hazards` needs no login, so anyone can create a hazard that changes routing.
- **Old branches:** five old worktree branches under `.claude/worktrees/` can be cleaned up once the sounds branch is merged.
