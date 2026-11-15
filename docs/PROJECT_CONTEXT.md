# TADDPOLE — Project Context

_Turn Around and Don't Drown: Protecting Overly Lackadaisical Earthlings_

This file pulls together everything decided and built across the Claude Code sessions in this repo on **Nov 14, 2026** (SunHacks). It's meant as the one-stop briefing for a teammate or a new session. Secrets are deliberately left out; they live in `backend/.env` (local) and `/opt/floodroute/backend/.env` (server).

---

## 1. What it is

A live flood-warning and rerouting app for drivers in Phoenix, AZ. Water-level sensors sit at flood-prone road dips. When water rises, the sensor's pin turns yellow, then red; drivers whose route crosses it get an alert and are automatically rerouted around it. The demo area is Arcadia / Camelback East, centred on the **40th St & Camelback** dip.

- **Original working name:** FloodRoute (still used in some paths, e.g. `/opt/floodroute`, `handoff/floodroute-handoff/`).
- **Product name:** **TADDPOLE**, always written in capitals.
- **Mascot:** a blue frog ("froglet": tadpole with back legs) wearing a yellow hooded raincoat. It is the car marker on the map, the "O" in the logo, the favicon, and the recenter button.
- **Live site:** https://ifyourreadingthisimstranded.us (also `www.`). Server IP `3.134.144.194`.
- **GitHub:** `noahcilliers/TADDPOLE-Turn-Around-and-Don-t-Drown-Protecting-Overly-Lackadaisical-Earthlings`

### Motivation (from the research session)
No official 2026 Arizona monsoon total exists. The estimate built from agency and news reports: about **120–250 vehicle flood rescues** (most likely 150–200) and **400–800 stranded vehicles** during the Jun 15 – Sep 30 season. Tucson Fire alone logged 43 swift-water calls vs 8 the year before. Source URLs are in the "Arizona monsoon flood rescues estimate" session.

---

## 2. Architecture

```
Arduino/ESP32 ultrasonic sensor (in a tub)
   │ serial
   ▼
Python logger on a laptop ──INSERT──► Tiger Data (TimescaleDB): water_levels
                                              │
Webcam on laptop ─► scripts/camera_server.py  │ (read-only polling, 1 s)
   (via cloudflared tunnel)                   ▼
                         backend/  FastAPI on EC2 (docker compose + Caddy)
                           poller → spike filter → status (clear/caution/flooded/offline)
                           → camera/Gemini "is it really water?" gate
                           → WebSocket push, Discord alerts, OSMnx rerouting
                                              │ /v1 REST + /v1/live WebSocket
                                              ▼
                         frontend/ React 19 + Vite + Leaflet
                           Stage layout (laptop/projector) + Phone layout (judges)
```

### Data source (real Tiger schema)
The database did **not** match `docs/flood_db_schema.md`. What's actually there:

| Table | Owner | Notes |
|---|---|---|
| `water_levels(time, sensor_id, distance_inches)` | Sensor logger | Hypertable. The backend never alters or writes to it, except the token-protected simulate endpoint. PK changed to **`(sensor_id, time)`** (was `time` only) without touching the logger (`backend/scripts/tiger/001_water_levels_pk.sql`). |
| `sensors` | Backend | Name, lat/lon, `baseline_cm` (dry distance) per `sensor_id`. |
| `flood_readings` view | Backend | Converts inches to depth in cm. |
| `sensor_status`, `status_events` | Backend | Current status and history. |
| `water_levels_1m` | Backend | Per-minute summary for charts. |
| simulated readings table | Backend | 24 h replay data for the 6 simulated sensors (~51k rows). Never written into `water_levels`. |
| `sensor_data` view | ? | Empty, unused, left alone. |

**Depth formula:** `depth = baseline − distance`. `water_tank_1` baseline = **24 in** (so a reading of 15 in = 9 in of water).

### Sensors
- `water_tank_1`: the one real sensor. Placed on the map at the dip on 40th St just south of Camelback.
- `FR-02`, `FR-03`, `FR-09`, `FR-11`, `FR-12`, `FR-14`: simulated, replaying 24 h profiles from the design handoff (depths scaled by `SIM_DEPTH_SCALE`).
- The sensor ID is hardcoded in the logger (`SENSOR_NAME = "water_tank_1"`). Adding a sensor means a new ID in the logger plus a matching row in `sensors`.

---

## 3. Backend (`backend/`)

FastAPI + asyncpg + pydantic-settings. Key modules in `backend/app/`:

| Module | What it does |
|---|---|
| `poller.py` | Polls every 1 s, computes status, pushes every new reading (max one per 2 s per sensor). |
| `status.py` | Status rules. **caution:** depth ≥ 5 cm or rising ≥ 2 cm/min. **flooded:** ≥ 15 cm. **offline:** no reading for 5 min. Median of last 3 readings, 2 cm hysteresis before downgrading. |
| `filters.py` | Hampel spike filter for chart/stats (`/series`, `/stats`). Rise rate uses the median of the oldest 3 readings. |
| `routing.py` | Local routing on `data/camelback.graphml` (OSMnx). Flooded segment hard-blocked; roads within `FLOOD_BLOCK_RADIUS_M` (300 m) cost 40×; soft buffer to `FLOOD_BUFFER_M` (700 m); roads near clear sensors get a small discount, near caution sensors cost 2×. A car already inside the zone can still route out. |
| `hub.py`, `live.py` | WebSocket hub (`/ws` legacy, `/v1/live`). |
| `v1.py`, `v1routes.py`, `steps.py` | `/v1` API, safer routes with turn-by-turn steps. |
| `demo.py` | Shared server-side demo clock (one clock, every screen follows it). Scripted water curve lasts 124 s, then holds at peak; clock runs up to 10 min. |
| `hazards.py` | Stalled-car hazards. |
| `simulator.py` | Simulated sensors. |
| `discord_alerts.py` | Queued Discord webhook posts on flooded/reopened, 60 s cooldown, simulated sensors skipped, `@everyone` mention on flooded. |
| `camera.py` | Camera + Gemini water check (see below). |

### Camera / Gemini water check (latest feature, uncommitted)
Before a status goes **up**, the backend grabs a photo and asks Gemini whether it's actually water.
- **Water:** alert proceeds. **Not water** (object under the sensor, dry tub): status held, no alert or reroute; it re-checks every 10 s. **Camera/Gemini failure or unclear photo:** fails open (alert goes out). Going **down** never waits.
- The scripted demo skips the camera; admin `simulate` readings do not.
- `CAMERA` can be a webcam index (local backend) or a URL. In production, `scripts/camera_server.py` on the laptop serves `/snapshot.jpg` on `127.0.0.1:8090` (requires `X-Camera-Token`), exposed via `cloudflared tunnel --url http://localhost:8090`. The quick-tunnel URL changes on every restart, so `CAMERA` on EC2 must be updated each time (`docker compose up -d api` after editing).
- Debug: `GET /health` shows `camera.enabled`; `GET /camera/water_tank_1/last.jpg` shows the last photo judged.
- `requirements-camera.txt` (opencv etc.) is laptop-only; `google-genai` was added to `requirements.txt` for the Docker image.
- **Open idea:** flip it so the laptop pushes frames to EC2 (no tunnel, fixed config). Proposed, not built.

### API
Contract: `backend/API_V1.md` (older: `backend/API.md`).

- **Public:** `GET /v1/config`, `/v1/sensors`, `/v1/sensors/{id}`, `/series`, `/stats`, `/status-changes`, `/v1/events`, `POST /v1/routes`, `POST /v1/hazards`, `GET /v1/hazards/active`, `GET /v1/demo`, `WS /v1/live`.
- **Admin (`X-Admin-Token`):** `DELETE /v1/hazards/{id}`, `POST /v1/demo/start|pause|speed|mode|scripted|stall|reset`, `POST /admin/sensors/{id}/simulate`, `POST /admin/discord/test`. Admin routes 404 if `ADMIN_TOKEN` is unset.
- **Legacy (unused by frontend but still public):** `/health`, `/config`, `/sensors`, `/sensors/{id}/history`, `/events`, `/route`, `/ws`.

### Config (`backend/.env.example`)
`DATABASE_URL` (or `TIGER_DB`), `SITE_ADDRESS`, `CORS_ORIGINS`, `ADMIN_TOKEN`, `POLL_INTERVAL_S`, `CAUTION_CM`, `FLOODED_CM`, `RISE_RATE_CM_PER_MIN`, `RISE_WINDOW_S`, `MEDIAN_OF`, `HYSTERESIS_CM`, `SPIKE_HALF_WINDOW`, `SPIKE_SIGMAS`, `SPIKE_MIN_CM`, `STALE_AFTER_S`, `OFFLINE_AFTER_S`, `SIM_DEPTH_SCALE`, `GRAPH_PATH`, `FLOOD_BLOCK_RADIUS_M`, `FLOOD_BUFFER_M`, `DISCORD_WEBHOOK_URL`, `DISCORD_NOTIFY_ON`, `DISCORD_COOLDOWN_S`, `DISCORD_INCLUDE_SIMULATED`, `DISCORD_MENTION`, `DISCORD_APP_URL`, `GEMINI_API_KEY`, `CAMERA`, `CAMERA_TOKEN`, `CAMERA_SENSORS`, `GEMINI_MODEL`.

### Tests
`cd backend && .venv/bin/python -m pytest` — 78 tests passing as of the camera work.

---

## 4. Frontend (`frontend/`)

React 19 + Vite + Leaflet 1.9.4, built from the design handoff in `handoff/floodroute-handoff/` (18 screens, OpenAPI, data model, logic docs, reference `sim.js`).

- **Maps:** OpenStreetMap tiles (greyed per tile), Nominatim for address search (limited to the map area, 1 req/s). No paid map API.
- **Layouts:** `?view=stage` / `?view=phone` to force.
  - **Stage (laptop/projector):** resizable left panel (320 px – 60%, double-click resets to 480 px) with the logo at top and Sensor / All sensors / Alerts; map on the right with legend and demo panel. Top-left map widgets removed.
  - **Phone (judges' view):** opens straight to Drive; tabs **Sensors · Drive · Alerts** (Map tab removed); no "Watching for floods" banners; no demo controls; settings is the gear on Sensors; no "arrived safely" UI anywhere.
- **Drive engine (`drive.tsx`):** car moves step by step, never jumps, holds ~90 m before any flooded dip; a dip that read flooded in the last 30 s still counts. Demo always starts on the fastest route through the live sensor.
- **Alerts:** one notification bar, one size (~80 px desktop / 72 px phone), colour only changes (red flood/stall, yellow rising, white info). On a flood on the route: red "Flooded ahead · Rerouting…", then ~1.5 s later "Rerouted around flooding · +N min", cleared after ~6.5 s. **Rerouting is automatic** (no Reroute/× buttons). If no flood-free route: "No flood-free route right now · holding here", retry every 8 s. Off-route floods get one notice per sensor per trip.
- **Map:** layers are created once and updated in place; route drawn once per reroute; simplification off; dashed red circle shows the closed zone. **Continuous follow** of the frog; dragging detaches, zooming doesn't; the frog button re-attaches (blue ring = following). Mac trackpad pinch handled by `components/trackpadPinch.ts` (PR #1).
- **Frog heading:** shortest-way rotation with a 12° deadband, heading taken 15 m ahead along the route (`geo.ts: headingAt`).
- **Sounds (`sounds.ts`):** short two-note "ding-dong" when flooding is on your route; soft rising chime on arrival. Generated with Web Audio, unlocked on first tap.
- **Demo panel (stage, needs demo key):** Water source = **Automatic flood** (scripted) or **Live sensor**, Play/Reset, Speed. Navigate/Watch-only and stalled-car toggles were removed. Unlock on a device with `?demo_key=<ADMIN_TOKEN>` once; viewers need no key.
- **Mascot art:** `components/frogSvg.ts` (shared source; `COAT_YELLOW`, `COAT_TRIM`), `public/favicon.svg` (hand-copied), presentation exports in `mascot/` (`taddpole-face.png/svg`, `taddpole-full.png/svg`, transparent). Final version = original round hood with the top seam line removed.

---

## 5. Deployment

- **AWS EC2:** instance `i-00c908008fffb79a7`, t3.small, Amazon Linux 2023, us-east-2 (Ohio), Elastic IP `3.134.144.194`. Code lives at `/opt/floodroute/`.
- **Stack:** docker compose with `api` and `caddy` containers. Caddy serves the frontend, proxies the API/WebSocket, and gets Let's Encrypt certs automatically.
- **Domain:** `ifyourreadingthisimstranded.us` (Porkbun), A records for `@` and `www` → `3.134.144.194`. `SITE_ADDRESS` is set to both names, so plain `http://<ip>` now redirects and `https://<ip>` fails; share the domain.
- **Deploy** (rsyncs local `backend/` + `frontend/`, rebuilds, leaves the server `.env` alone; no git push needed):
  ```bash
  cd /Users/noahcilliers/UNSTUCK/backend && HOST=ec2-user@ifyourreadingthisimstranded.us KEY=~/.ssh/taddpole.pem ./deploy/deploy.sh
  ```
- **Server `.env`:** `/opt/floodroute/backend/.env` (edit via EC2 Instance Connect + `nano`). Copy a local `.env` up with `scp` if needed.
- `backend/data/` (incl. `camelback.graphml`) is gitignored; rebuild with `backend/scripts/build_graph.py` (needs a custom User-Agent for Overpass). Worktrees need it copied in before deploying.
- **Important:** deploys ship whatever is on disk in the checkout you run from. Deploying from a stale worktree or checkout can roll back live features (this happened once with the mascot vs sounds).
- **Don't run a local backend against Tiger Data at the same time as EC2**: both pollers write status history and post to Discord.

### Local dev
```bash
cd backend && docker compose -f docker-compose.dev.yml up -d   # throwaway TimescaleDB
DATABASE_URL=postgresql://postgres:password@localhost:5432/postgres ADMIN_TOKEN=devtoken .venv/bin/uvicorn app.main:app --reload
npm --prefix frontend run dev    # :5173, proxies /v1 to BACKEND_URL
.venv/bin/python scripts/fake_writer.py --sensor water_tank_1 --ramp 0 25 20   # fake a flood
```
`.claude/launch.json` has a `frontend-prod-api` entry that proxies to the **live** backend. Demo buttons there act on the live demo (rejected without the real key).

---

## 6. Timeline of sessions (Nov 14, 2026, Phoenix time)

| Session | What happened |
|---|---|
| Backend polling and notifications (main, very long) | Grill-me design; built backend; adapted to the real Tiger schema; changed `water_levels` PK; built the whole frontend from the handoff with a parallel backend agent for `/v1`; stage layout rework + resizable panel; live Tiger streaming (24 in baseline); car never drives into water; renamed to TADDPOLE; smoother map; AWS EC2 deploy; domain + HTTPS; clean phone view; removed "arrived" UI; route wobble fix; wider flood avoidance; frog recenter button; reroute-after-dismiss bug; unified notifications; continuous follow; automatic reroute. |
| Water data spike filtering | Hampel filter for charts/stats; median-based rise rate. |
| Git ignore and README | Root `.gitignore` + `README.md`; fixed large-push HTTP 400 (`http.postBuffer`), removed `backend/data` from history via soft reset. |
| Taddpole mascot mockups | Tadpole options → froglet chosen; heading-flip fix; frog-face "O" in logo; blue colour; favicon; raincoat versions (B hood chosen), seam line removed; transparent PNG/SVG exports. |
| Discord notifications | Discord webhook alerts, `@everyone` on flooded, test endpoint. |
| Demo options and sensor routing | Simplified demo panel to Automatic flood vs Live sensor; demo always routes through the live sensor. |
| Mac trackpad zoom performance (worktree) | Trackpad pinch handler; PR #1, merged and deployed. |
| Arrived and flood alert sounds (worktree) | Alert + arrival sounds; redeployed with the new mascot; merged to `main`. |
| Arizona monsoon flood rescues estimate | Research for the pitch (see §1). |
| Map API / Surfaced endpoints | Read-only Q&A: map stack is all OSM; full endpoint inventory (§3). |
| Water detection camera integration | Camera + Gemini gate, snapshot server, tunnel instructions, EC2 env + deploy, test plan. |

---

## 7. Current state & open items

**Git:** `main` at `5bfc779 new mascott`. Uncommitted: the camera work (`backend/app/camera.py`, `config.py`, `main.py`, `poller.py`, `requirements*.txt`, `.env.example`, `README.md`, `scripts/camera_server.py`, `tests/test_camera.py`). Old worktree branches (`arizona…`, `arrived…`, `mac-trackpad…`, `map-api…`, `surfaced-endpoints…`) can be cleaned up.

**Before / during the demo**
- Start the Arduino logger (Mac port is `/dev/cu.usbmodem*`, not `COM3`), or use Automatic flood.
- For the camera check: run `camera_server.py` + `cloudflared`, make sure `CAMERA` on EC2 matches the current tunnel URL, `caffeinate -d`, and check `/health` shows `camera.enabled: true`. Not yet verified end to end with the real webcam + Gemini.
- Keep the demo key (`ADMIN_TOKEN`) off slides and shared chats.

**After the hackathon**
- **Rotate secrets:** the Tiger `tsdbadmin` password and Discord webhook URL were hardcoded in the logger script and pasted into chat. Move them to env vars.
- Tighten the EC2 SSH rule (currently `0.0.0.0/0`) back to "My IP" or use SSM.
- `POST /v1/hazards` is unauthenticated (anyone can create a hazard that affects routing).
- Consider removing legacy un-prefixed routes from the Caddy matcher.
- Logger robustness: add a timeout to the Discord post, reconnect on DB errors, take `SERIAL_PORT`/`SENSOR_NAME` from argv.
- Handoff docs mention endpoints that don't exist (`POST readings`, `POST hazards-ahead`); the "what's ahead" check runs client-side.
- Unbuilt ideas from the vision doc: driver "I'm stuck" reports, Gemini-written alert text, Web Push/SMS, upstream rain gauges.
- If real traffic arrives: move off public OSM tile/Nominatim servers (MapTiler, Stadia, or self-hosted).
