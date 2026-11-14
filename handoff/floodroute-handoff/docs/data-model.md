# Data model

Canonical units: **depth in cm**, distance in **metres**, time in **UTC ISO-8601** (Phoenix is UTC−7 all year, no DST). Coordinates are **[lng, lat]** GeoJSON.

## Sensor
A fixed water-depth sensor at a flood-prone dip.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Device ID printed on the unit, e.g. `FR-07` |
| `name` | string | Intersection label shown everywhere, e.g. "40th St & Camelback" |
| `road` | string | Segment description, e.g. "N 40th St dip, south of Camelback Rd" |
| `location` | GeoJSON Point | Pin position |
| `segment` | GeoJSON LineString | The road stretch the sensor watches; drawn in status color and used for route-crossing checks |
| `battery_pct` | int 0–100, nullable | Latest from device |
| `signal` | enum `strong` `good` `weak` `lost` | Latest from device |
| `calibrated_at` | date | Last calibration |
| `installed_at` | timestamp | |
| `current` | SensorState | See below (denormalised for fast reads) |

## SensorState (one row per sensor, updated on every reading)

| Field | Type | Notes |
|---|---|---|
| `status` | enum `clear` `caution` `flooded` `offline` | See `logic.md` |
| `depth_cm` | number, nullable | null when offline |
| `rate_cm_per_min` | number, nullable | 5-minute slope |
| `last_reading_at` | timestamp | |
| `status_since` | timestamp | When the current status began |

## Reading (time series, the big table)

| Field | Type | Notes |
|---|---|---|
| `time` | timestamptz | Device timestamp (server time if device has no clock) |
| `sensor_id` | string | |
| `depth_cm` | real | Water above road surface. 0 = dry. |
| `battery_pct` | smallint, nullable | |
| `rssi_dbm` | smallint, nullable | |

Expected rate: one reading every 5–15 s per sensor during storms. Charts use 1-min and 5-min aggregates.

## StatusChange

| Field | Type |
|---|---|
| `time` | timestamptz |
| `sensor_id` | string |
| `from_status`, `to_status` | status enum |
| `depth_cm` | real, nullable |

Feeds "Status changes · last 24 h" on the analytics panel and the sensor events in the alert feed.

## Hazard (driver or system reports that aren't sensor readings)

| Field | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `kind` | enum `stalled_vehicle` (extensible: `road_closed`, `debris`) | |
| `location` | Point | |
| `sensor_id` | string, nullable | Nearest sensor if within ~150 m |
| `source` | enum `driver` `sensor` `operator` `demo` | |
| `created_at`, `expires_at` | timestamptz | Default TTL 30 min; cleared when the linked sensor returns to `clear` |

## Event (what the alert feed shows)
A read model merged from `status_changes` and `hazards`, plus per-user items the client adds locally ("You were warned", "Route recalculated", "Arrived safely").

| Field | Type |
|---|---|
| `id` | string |
| `time` | timestamptz |
| `kind` | `status_change` `hazard` |
| `sensor_id` | string, nullable |
| `title` | string ("40th St & Camelback") |
| `from_status`, `to_status` | for status changes |
| `depth_cm` | nullable |
| `detail` | string |

## Route (response object, not stored unless you want trip history)

| Field | Type |
|---|---|
| `id` | string |
| `kind` | `fastest` `safer` |
| `duration_s`, `distance_m` | int |
| `geometry` | LineString |
| `steps[]` | `{instruction, distance_m, road}` |
| `crosses[]` | `{sensor_id, name, status, depth_cm, at_distance_m}` for every sensor segment within ~30 m of the route |
| `safe` | bool: no `flooded`/`offline` crossings and no active hazard on route |
| `delta_vs_fastest_s` | int (safer route only), drives "+3 min" |

## DemoSession

| Field | Type |
|---|---|
| `state` | `idle` `playing` `paused` |
| `mode` | `nav` `watch` |
| `speed` | 0.5–4 |
| `demo_s` | current demo second |
| `stall_at` | demo second the stalled car was triggered, nullable |
