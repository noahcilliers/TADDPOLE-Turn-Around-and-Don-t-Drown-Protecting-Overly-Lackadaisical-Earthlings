# Screens → data

Every screen in `screens/png/`, what it shows, and what feeds it. Field names refer to `docs/data-model.md`; endpoints to `docs/api.md`.

Global elements on most screens:

| Element | Data | Source |
|---|---|---|
| "Live · 2 s ago" pill | seconds since last realtime message | WS `heartbeat` / any message |
| Status count chips ("1 flooded · 1 rising · 4 clear · 1 offline") | count of sensors by `status` | `GET /v1/sensors` then WS updates |
| Map pins + highlighted road segments | `location`, `segment`, `status` per sensor | `GET /v1/sensors` |
| Flooded pins pulse | `status == flooded` | — |

Status vocabulary in the UI: `clear` → "Clear", `caution` → "Rising", `flooded` → "Flooded", `offline` → "Offline". Each has its own shape (circle ✓, triangle !, octagon ✕, dashed circle –), so the API only needs to send the status string.

---

## Interactive prototypes

### `A2-Phone` (phone app, clickable)
Screenshots: `A2-Phone__01…11.png`

| State | What it needs |
|---|---|
| 01 Map + sensor card | `GET /v1/sensors` (pins), selected sensor: `name`, `status`, `depth_cm`, `rate_cm_per_min`, `last_reading_at` |
| 02–04 Analytics sheet (past hour / 6 h / 24 h) | `GET /v1/sensors/{id}` + `/series?range=` + `/stats?range=` + `/status-changes?since=24h` + health (`battery_pct`, `signal`, `calibrated_at`) |
| 04 Offline sensor analytics | series has a gap; `current.depth_cm = null`, `last_reading_at` drives "No reading for N min" |
| 05–07 Drive › Navigate | `POST /v1/routes`; WS `sensor.status_changed` on any sensor the active route crosses → re-request route → "Route recalculated, +3 min" toast; arrival summary |
| 08–09 Drive › Watch only | client posts position + heading to `POST /v1/hazards/ahead` (or computes locally from the sensor list) → heads-up strip, yellow card, red full-width alert with distance countdown |
| 10 Stalled car | WS `hazard.created` (kind `stalled_vehicle`) → instant red alert regardless of distance |
| 11 Alerts tab | `GET /v1/events?since=` + WS events appended live |

### `A2-Stage` (laptop / projector, clickable)
Screenshots: `A2-Stage__01…06.png`

Same data as the phone, laid out wide: map with clickable sensors, right panel tabs **Sensor** (analytics), **All sensors** (ranked list: flooded, caution, offline, clear; then by depth), **Alerts** (feed). Floating **Demo** panel → `POST /v1/demo/*`.

---

## Static screens

| File | Screen | Data / endpoints |
|---|---|---|
| `A2-Welcome` | Welcome + permissions | none (client-only) |
| `A2-Sensors` | All sensors list, search, sort by "Most at risk / Nearest / On my route" | `GET /v1/sensors?near=lng,lat` (adds `distance_m`), `?route_id=` filter |
| `A2-Analytics` | Sensor analytics, 24 h | `/series?range=24h`, `/stats?range=24h`, `/status-changes?since=24h` |
| `A2-Offline` | Offline sensor card | `status=offline`, `last_reading_at`, last known `depth_cm`, `battery_pct`, `signal`; series with gap |
| `A2-Watching` | Driving with no destination | `POST /v1/hazards/ahead` → nearest hazard ahead + distance |
| `A2-Navigating` | Turn-by-turn on the safer route, "Rerouted around …" banner | `POST /v1/routes` response: `steps`, `duration_s`, `distance_m`, `crosses[]` (all clear) |
| `A2-Caution` | Yellow "Water rising ahead" card | hazard ahead with `status=caution`, `depth_cm`, `rate_cm_per_min`, `distance_m` |
| `A2-Stalled` | Red "Car stalled ahead" | WS `hazard.created` with `kind=stalled_vehicle`, linked sensor depth |
| `A2-Summary` | Trip summary ("Avoided 40th St & Camelback") | client trip log + `crosses[]` of avoided route; optional `POST /v1/trips` |
| `A2-Feed` | Alert feed with filters All / Near me / My routes / Following | `GET /v1/events?since=&near=&sensor_ids=` |
| `A2-Settings` | Look-ahead distance, alert types, sound, units, avoid offline sensors | client-side; optionally `PUT /v1/devices/{id}/settings` so push alerts use the same radius |
| `A2-Offline-Conn` | Lost connection: "No live data, last update 2 min ago" | WS disconnected / heartbeat older than ~10 s; show last known state |
| `OptA-Map` | Map + floating sensor card | as A2-Phone 01 |
| `OptA-Route` | From/To, on-map time bubbles, "Take safer route" | `POST /v1/routes` |
| `OptA-Alert` | Red flooded alert over map | hazard ahead, `distance_m`, `depth_cm` |
| `OptA-Brand` | Logo, colors, type | none |

## Copy that depends on data

- Depth: `"{cm} cm"` big, `"{in} in"` small, plus `"~{ft} ft"` when ≥ 27 cm. Inches = cm / 2.54 (1 dp). Backend sends cm only.
- Trend: `rate_cm_per_min > 0.3` → "Rising +x cm/min"; `< -0.3` → "Falling"; else "Steady".
- Updated: `now - last_reading_at` → "Updated 3 s ago" / "No reading for 18 min".
- Distance in alerts: miles with 2 dp under 1 mi (the API sends metres).
