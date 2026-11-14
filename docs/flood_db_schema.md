### `sensors`

| Column | Type | Notes |
|---|---|---|
| `sensor_id` 🔑 | TEXT | Same string as in firmware |
| `name` | TEXT | `40th St & Camelback` |
| `lat` | DOUBLE PRECISION | |
| `lon` | DOUBLE PRECISION | |
| `baseline_cm` | REAL | `distance_cm` when the road is dry |

### `readings` (hypertable, partitioned on `time`)

| Column | Type | Set by | Notes |
|---|---|---|---|
| `time` ⏱ | TIMESTAMPTZ | Server | Arrival time |
| `sensor_id` | TEXT | ESP32 | FK → `sensors` |
| `seq` | INTEGER | ESP32 | Nullable |
| `distance_cm` | REAL | ESP32 | Raw ultrasonic value |
| `depth_cm` | REAL | Server | `max(0, baseline_cm − distance_cm)` |
| `battery_v` | REAL | ESP32 | Nullable |
| `rssi` | SMALLINT | ESP32 | Nullable |
