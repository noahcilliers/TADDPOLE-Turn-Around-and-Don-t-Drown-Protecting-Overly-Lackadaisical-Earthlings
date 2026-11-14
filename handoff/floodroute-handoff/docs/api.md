# API

Base path `/v1`. JSON everywhere. Example payloads for every call are in `../examples/`. Formal spec: `../api/openapi.yaml`.

Auth: public read endpoints need no auth (it's a safety app). Device ingest uses a per-device key (`Authorization: Bearer <device_key>`). Demo endpoints use an operator key.

## Sensors

| Method | Path | Returns | Screens |
|---|---|---|---|
| GET | `/v1/sensors` | All sensors with `current` state. Optional `near=lng,lat` adds `distance_m` and sorts by it; `sort=risk` (default) sorts flooded → caution → offline → clear, then depth desc. | Map, All sensors, Stage › All sensors |
| GET | `/v1/sensors/{id}` | One sensor incl. health fields | Sensor card, Analytics |
| GET | `/v1/sensors/{id}/series?range=1h\|6h\|24h` | 120 max-buckets, `null` = gap | Analytics chart |
| GET | `/v1/sensors/{id}/stats?range=1h\|6h\|24h` | peak, peak_at, fastest_rise, minutes_above_caution, minutes_flooded | Analytics stats |
| GET | `/v1/sensors/{id}/status-changes?since=24h&limit=5` | newest first | Analytics "Status changes" |

## Feed

| GET | `/v1/events?since=2h&near=lng,lat&radius_m=3000&sensor_ids=FR-07,FR-03` | merged status changes + hazards, newest first | Alerts tab, Stage › Alerts |

## Ingest (hardware)

| POST | `/v1/readings` | `{readings:[{sensor_id,time,depth_cm,battery_pct?,rssi_dbm?}]}` batch up to 500. Returns `202`. Idempotent on `(sensor_id,time)`. |

## Hazards

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/hazards` | Driver report, e.g. stalled car. Server links nearest sensor within 150 m, sets TTL 30 min, publishes `hazard.created`. |
| GET | `/v1/hazards/active` | For map + routing |
| DELETE | `/v1/hazards/{id}` | Operator clear |
| POST | `/v1/hazards/ahead` | `{position, heading_deg, speed_mps, radius_m, route_id?}` → `{level, nearest, hazards[]}` (see `logic.md` §4). Clients call every ~3 s while driving, plus on any relevant socket event. |

## Routing

| POST | `/v1/routes` | `{from:[lng,lat], to:[lng,lat], avoid_offline:true}` → `{recommended, routes:[fastest, safer]}` with `crosses[]`, `safe`, `delta_vs_fastest_s`, `steps[]`. |

## Realtime: `GET /v1/live` (WebSocket; SSE fallback at `/v1/live/sse`)

Server → client messages (`examples/WS_messages.json`):

| type | When |
|---|---|
| `heartbeat` | every 2 s. Client shows "Live · Ns ago"; after ~10 s without any message it shows the "Reconnecting / No live data" state. |
| `sensor.reading` | new reading (throttled 1 per sensor per 2 s) |
| `sensor.status_changed` | status transition |
| `hazard.created` / `hazard.cleared` | hazard lifecycle |
| `demo.tick` | demo running: `{demo_s, mode, speed}` |

Client → server (optional): `{type:"subscribe", bbox:[w,s,e,n]}` to limit traffic.

## Demo (operator key)

| POST | `/v1/demo/start` | `{mode:"nav"\|"watch", speed:2}` starts or resumes replay of `data/demo_scenario.json` |
| POST | `/v1/demo/pause` | |
| POST | `/v1/demo/speed` | `{speed:0.5–4}` |
| POST | `/v1/demo/stall` | stalled car at FR-07 (`source=demo`) |
| POST | `/v1/demo/reset` | removes all `source=demo` data, FR-07 back to 3 cm |
| GET | `/v1/demo` | DemoSession |

## Errors

`{error:{code, message}}` with 400 / 401 / 404 / 409 / 429. Readings older than 24 h or more than 60 s in the future → 400.
