# Flood Route API — frontend contract

Base URL: `https://<your-domain>` (or `http://localhost:8000` locally). WebSocket: `wss://<your-domain>/ws`.

Coordinates: request bodies use `{lat, lon}`; route geometry is **GeoJSON** (`[lon, lat]`), so pass it straight to `L.geoJSON(feature)`.

Status values: `clear` (green) · `caution` (yellow) · `flooded` (red). `stale: true` = no reading for 60 s (grey the pin out; status is held, not reset).

---

## Sensor object

```json
{
  "sensor_id": "water_tank_1",
  "name": "40th St & Camelback",
  "lat": 33.511, "lon": -111.9953,
  "status": "flooded",
  "depth_cm": 22.3,
  "rise_cm_per_min": 4.1,
  "last_reading_at": "2026-11-14T19:55:57.12+00:00",
  "stale": false
}
```

## REST

| Method | Path | Returns |
|---|---|---|
| GET | `/sensors` | `Sensor[]` — current state of every pin |
| GET | `/sensors/{id}/history?minutes=60` | `[{bucket, avg_depth_cm, max_depth_cm, n}]` per minute (from the `water_levels_1m` Tiger Data continuous aggregate) — for a depth chart |
| GET | `/events?limit=50&sensor_id=` | `[{time, sensor_id, name, prev_status, status, depth_cm, rise_cm_per_min}]` newest first — timeline / activity feed |
| GET | `/route?from=lat,lon&to=lat,lon` | Route Feature (below). `409` if flooding cuts every path, `503` if routing is off |
| GET | `/config` | `{thresholds_cm: {caution, flooded}, rise_rate_cm_per_min, bounds: [west, south, east, north]}` — use `bounds` to fit the map / validate picks |
| GET | `/health` | `{ok, last_poll, last_error, routing, clients}` |
| POST | `/admin/sensors/{id}/simulate` | Header `X-Admin-Token`, body `{"depth_cm": 20}` → writes a fake reading (demo fallback if the hardware dies). Send `0` to drain. |

### Route Feature

```json
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": [[-111.9953, 33.505], ...] },
  "properties": {
    "distance_m": 3038.0,
    "duration_s": 197.0,
    "sensors_on_route": [],
    "avoided_sensors": ["water_tank_1"]
  }
}
```

`avoided_sensors` = flooded spots the normal fastest route would have gone through (show "Avoiding 40th St & Camelback").

---

## WebSocket `/ws`

### Client → server

```jsonc
{"type": "set_route", "origin": {"lat": 33.505, "lon": -111.9953}, "destination": {"lat": 33.516, "lon": -111.9953}}
{"type": "clear_route"}
{"type": "ping"}
```

Sending `set_route` registers this connection as a driver on that route; it then receives targeted alerts and automatic reroutes. Without it, the client only gets pin updates (dashboard mode).

### Server → client

```jsonc
// on connect: full snapshot for the pins
{"type": "hello", "client_id": 1, "sensors": [Sensor, ...], "at": "..."}

// any pin changed (status, depth, staleness) — broadcast to everyone
{"type": "sensor_update", "sensor": Sensor}

// route for this client
{"type": "route",
 "reason": "requested" | "rerouted" | "restored" | "no_route",
 "message": "Avoiding 40th St & Camelback." | null,
 "route": RouteFeature | null,          // null when reason = no_route
 "at": "..."}

// targeted alert — only to drivers whose route crosses that sensor
{"type": "alert", "alert": {
   "id": "uuid",
   "severity": "flooded" | "caution" | "cleared",
   "sensor_id": "water_tank_1",
   "sensor_name": "40th St & Camelback",
   "depth_cm": 61.0,
   "lat": 33.511, "lon": -111.9953,
   "message": "Flooded ahead at 40th St & Camelback, about 2 ft deep. Rerouting you.",
   "at": "..."}}

{"type": "pong", "at": "..."}
{"type": "error", "message": "..."}
```

### Demo sequence the UI should handle

1. `hello` → draw pins.
2. User picks A → B → send `set_route` → `route{reason: requested}` → draw line.
3. Water rises → `sensor_update` (pin yellow) → `alert{severity: caution}` if on route.
4. Crosses 15 cm → `sensor_update` (pin red) → `alert{severity: flooded}` (banner) → `route{reason: rerouted}` (swap line).
5. Drains → `sensor_update` (green) → `alert{severity: cleared}` → `route{reason: restored}`.

Reconnect logic: on close, reconnect with backoff and resend `set_route` — server state is per connection.
