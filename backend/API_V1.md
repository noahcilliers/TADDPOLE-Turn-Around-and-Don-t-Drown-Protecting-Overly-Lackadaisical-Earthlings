# Flood Route API v1: contract between `backend/` and `frontend/`

Adapted from the design handoff (`handoff/floodroute-handoff/docs/api.md`) to our system.
Units: depth **cm**, distance **m**, time **UTC ISO-8601**, coordinates **[lng, lat]** GeoJSON.
Status enum: `clear | caution | flooded | offline`. The old unprefixed endpoints and `/ws` stay as they are.

Sensors: the real `water_tank_1` (40th St & Camelback, the handoff's FR-07 spot) plus 6 simulated sensors
`FR-02, FR-03, FR-09, FR-11, FR-12, FR-14` replaying `handoff/.../data/readings_24h.csv` (flag `simulated: true`).

## Sensor

```jsonc
{
  "id": "water_tank_1",
  "name": "40th St & Camelback",
  "road": "N 40th St dip, south of Camelback Rd",
  "simulated": false,
  "location": {"type": "Point", "coordinates": [-111.99532, 33.5085]},
  "segment":  {"type": "LineString", "coordinates": [[...], [...]]},  // snapped road edge geometry; null if no graph
  "battery_pct": null, "signal": null, "calibrated_at": null,          // nullable; real sensor doesn't report them
  "distance_m": 812,                                                    // only with ?near=
  "current": {
    "status": "flooded",
    "depth_cm": 61.0,                 // null when offline or never read
    "rate_cm_per_min": 4.2,           // null when unknown
    "last_reading_at": "2026-...Z",   // null if never read
    "status_since": "2026-...Z"
  }
}
```
`offline` = no reading for `offline_after_s` (default 300). Offline sensors keep their last known `depth_cm`? **No**: `depth_cm` is null when offline; the last known depth is available from `/series`.

## REST (all public, except demo writes which need header `X-Admin-Token`)

| Method | Path | Returns |
|---|---|---|
| GET | `/v1/config` | `{thresholds: {caution_cm, flooded_cm}, offline_after_s, bounds: [w,s,e,n], demo: {from: [lng,lat], to: [lng,lat], destination_name, stall_lnglat: [lng,lat], sensor_id: "water_tank_1"}}` |
| GET | `/v1/sensors?near=lng,lat&sort=risk\|near` | `Sensor[]`. `sort=risk` (default): flooded, caution, offline, clear, then depth desc. `near` adds `distance_m`; `sort=near` sorts by it |
| GET | `/v1/sensors/{id}` | `Sensor` (404 if unknown) |
| GET | `/v1/sensors/{id}/series?range=1h\|6h\|24h` | `{range, bucket_s, points: [{t, depth_cm \| null}]}`. Exactly 120 buckets ending now (30 s / 180 s / 720 s); value = **max** depth in bucket; null = no readings (gap) |
| GET | `/v1/sensors/{id}/stats?range=1h\|6h\|24h` | `{peak_cm, peak_at, fastest_rise_cm_per_min, minutes_above_caution, minutes_flooded}` (nulls when no data). Fastest rise = max over the range of 5-min rate computed on 1-min max buckets |
| GET | `/v1/sensors/{id}/status-changes?since=24h&limit=5` | `[{time, from_status, to_status, depth_cm}]` newest first (`since` accepts `Nh` / `Nm`) |
| GET | `/v1/events?since=2h&limit=50` | `Event[]` newest first, merged status changes + hazards |
| POST | `/v1/routes` | body `{from: [lng,lat], to: [lng,lat], avoid_offline: true}` → `RoutesResponse` (below); 503 if routing off; 422 if points outside the map |
| POST | `/v1/hazards` | body `{kind: "stalled_vehicle", location: [lng,lat], source: "driver"}` → `Hazard` (201). Links nearest sensor within 150 m. TTL 30 min |
| GET | `/v1/hazards/active` | `Hazard[]` |
| DELETE | `/v1/hazards/{id}` | 204 (admin token) |
| POST | `/v1/camera/{id}` | Wi-Fi camera upload when `CAMERA=push`: body = raw JPEG (≤ 1 MB), header `X-Camera-Token`. 204; 401 bad token; 409 not in push mode; 404 sensor not in `CAMERA_SENSORS` |
| GET | `/v1/demo` | `DemoSession` |
| POST | `/v1/demo/start` | `{mode?, speed?}` → `DemoSession` (start or resume) |
| POST | `/v1/demo/pause` | `DemoSession` |
| POST | `/v1/demo/speed` | `{speed: 0.5..4}` |
| POST | `/v1/demo/mode` | `{mode: "nav" \| "watch"}` |
| POST | `/v1/demo/scripted` | `{enabled: bool}`: scripted flood curve for `water_tank_1` instead of the real tub |
| POST | `/v1/demo/stall` | `{enabled: bool}`: create / clear the demo stalled-car hazard at `stall_lnglat` |
| POST | `/v1/demo/reset` | `demo_s=0`, `state=idle`, deletes demo sim readings + demo hazards. `DemoSession` |

### Event
```jsonc
{"id": "sc_123" | "hz_<uuid>", "time": "...", "kind": "status_change" | "hazard",
 "sensor_id": "water_tank_1", "title": "40th St & Camelback",
 "from_status": "caution", "to_status": "flooded",          // status_change only
 "hazard_kind": "stalled_vehicle",                          // hazard only
 "depth_cm": 31.0, "detail": "31 cm · 12.2 in"}
```

### RoutesResponse
```jsonc
{"recommended": "r_safer",
 "routes": [
   {"id": "r_fast", "kind": "fastest", "duration_s": 360, "distance_m": 3219, "safe": false,
    "geometry": {"type": "LineString", "coordinates": [[lng,lat], ...]},
    "crosses": [{"sensor_id": "water_tank_1", "name": "40th St & Camelback", "status": "flooded", "depth_cm": 61, "at_distance_m": 2414}],
    "steps": [{"instruction": "Head north on North 40th Street", "road": "North 40th Street", "distance_m": 3219}]},
   {"id": "r_safer", "kind": "safer", ..., "safe": true, "delta_vs_fastest_s": 180}
 ]}
```
- `fastest` = shortest travel time ignoring floods. `crosses` = sensors whose snapped segment is on the route.
- Unsafe = crosses a `flooded` sensor, an `offline` one (when `avoid_offline`), or an active hazard's sensor.
- If fastest is safe → `routes = [fastest]`, `recommended = "r_fast"`.
- Else compute `safer` with those segments closed. If no path exists → `routes = [fastest]`, recommended `r_fast`, `safe: false`.

### Hazard
```jsonc
{"id": "uuid", "kind": "stalled_vehicle", "sensor_id": "water_tank_1" | null,
 "location": {"type": "Point", "coordinates": [lng, lat]},
 "source": "driver" | "demo" | "operator", "created_at": "...", "expires_at": "..."}
```
Cleared when TTL passes, on DELETE, on `demo/stall {enabled:false}` / `demo/reset`, or when its linked sensor returns to `clear`.

### DemoSession
```jsonc
{"state": "idle" | "playing" | "paused", "mode": "nav" | "watch", "speed": 2,
 "demo_s": 37.5,            // demo seconds elapsed at `at`
 "at": "...Z",              // server time demo_s was sampled; while playing clients extrapolate demo_s + (now-at)*speed
 "scripted": false, "stall": false, "duration_s": 124}
```
Scripted curve = `demo_scenario.json → timeline[].depth_cm` by `demo_s` (linear interpolation), written for `water_tank_1` once per real second while playing.

## WebSocket `/v1/live`

Server → client:
```jsonc
{"type": "hello", "time": "...", "sensors": [Sensor], "hazards": [Hazard], "demo": DemoSession, "config": {...same as /v1/config}}
{"type": "heartbeat", "time": "..."}                                   // every 2 s
{"type": "sensor.reading", "time": "...", "sensor": Sensor}            // visible change; ≤ 1 per sensor per 2 s
{"type": "sensor.status_changed", "time": "...", "sensor_id": "...", "from": "caution", "to": "flooded", "depth_cm": 30.2, "sensor": Sensor}
{"type": "hazard.created", "hazard": Hazard}
{"type": "hazard.cleared", "hazard_id": "...", "reason": "expired" | "sensor_clear" | "operator" | "demo"}
{"type": "demo.state", "demo": DemoSession}                            // on every demo change
```
Client → server: `{"type": "ping"}` → `{"type": "pong"}` (optional).

## Implementation notes (backend)

- **Thresholds.** Status uses the backend's `CAUTION_CM` / `FLOODED_CM` (default 5 / 15), not the handoff's 10 / 30. The handoff's simulated profiles and the scripted demo curve are scaled by `SIM_DEPTH_SCALE` (default `FLOODED_CM / 30` = 0.5) so they hit the same states and key moments (caution ≈ demo_s 18, flooded ≈ demo_s 42). Simulated and scripted depths are therefore half the design's numbers. Read thresholds from `/v1/config`; don't hard-code 10 / 30.
- **Rate.** `rate_cm_per_min` is the backend's net change over `RISE_WINDOW_S` (60 s), not the handoff's 5-min slope. `/stats` `fastest_rise_cm_per_min` *is* the 5-min rate on 1-min max buckets, as specified.
- **Hysteresis.** Downgrades need depth `HYSTERESIS_CM` below the threshold (no 120 s dwell).
- **Simulated sensors.** `FR-02/03/09/11/12/14` replay `data/readings_24h.csv` from `sim_readings` (never `water_levels`). Wall clock is anchored on first boot (`sim_state.profile_anchor`) to the CSV's end (the handoff's demo start), so first boot shows FR-03 caution and FR-02 offline. After that the replay ping-pongs (reverse, then forward) so it never jumps. FR-02 (`signal: lost`) never reports again.
- **Scripted demo.** While `scripted` is on, `water_tank_1` uses only `sim_readings` rows with source `demo` (written every second at the curve depth for the current `demo_s`, also while paused/idle); otherwise only real device rows. Reset deletes demo rows and forces the sensor back to `clear`.
- **Demo stall.** `/v1/demo/stall` links the hazard to `water_tank_1` explicitly. `stall_lnglat` is ~170 m from the sensor, outside the 150 m auto-link radius used for driver reports.
- **Routing.** "Fastest" ignores all floods/hazards. "Safer" closes the snapped segments of flooded sensors, offline sensors (when `avoid_offline`), hazard-linked sensors, and the nearest edge of unlinked hazards. `crosses[]` = sensors whose snapped segment is on the path (not the 30 m buffer test). Steps come from OSM `name`s, so instructions read like "Turn right onto East Thomas Road".
- **Events.** First observations (no previous status) are not events. Event ids are `sc_<sensor>_<epoch ms>` / `hz_<uuid>`.
- **Not implemented:** `POST /v1/readings` device ingest (the ESP32 writer inserts into `water_levels` directly), `/v1/hazards/ahead` (look-ahead is client-side), `?near`/`radius_m`/`sensor_ids` filters on `/v1/events`, SSE fallback, bbox subscribe.
