# Logic

All numbers below are defaults; keep them in one `config` table so the team can tune them. `reference/sim.js` implements the same rules and is the test oracle.

## 1. Status from depth

```
flooded  if depth_cm >= 30
caution  if depth_cm >= 10
         or (rate_cm_per_min >= 1.0 and depth_cm >= 5)    # optional early warning
clear    otherwise
offline  if no reading for 300 s  (overrides everything)
```

**Hysteresis (required).** The sample data shows why: FR-07 flips `caution → clear → caution` within two minutes at 10 cm (see `data/status_changes_24h.json`, 01:41–01:42 UTC). Downgrade only when depth stays `hysteresis_cm` (2 cm) below the threshold for 120 s. Upgrades apply immediately.

**Offline is never safe.** Routing treats `offline` like `flooded` by default (setting "Avoid offline sensors", on by default). The UI shows the last known depth and "No reading for N min".

## 2. Rate of rise

`rate_cm_per_min = (depth_now − depth_5min_ago) / 5`, using the 1-minute aggregate. Null if either end is missing. UI shows "Rising" above +0.3, "Falling" below −0.3.

## 3. Status-change pipeline

On every ingested reading:
1. Insert into `readings`.
2. Recompute rate + status with hysteresis.
3. If status changed: insert `status_changes`, update `sensor_state.status_since`, publish `sensor.status_changed`.
4. Always publish `sensor.reading` (throttle to 1 per sensor per 2 s on the socket).

A job every 15 s marks sensors `offline` whose `last_reading_at` is older than 300 s, through the same step 3.

## 4. Look-ahead alerts (Drive tab)

Input from the client: position, heading (deg), speed, look-ahead radius (setting: 500 m / 1 km / 2 km).

A sensor is **ahead** when:
- distance ≤ radius, and
- the bearing from car to sensor is within ±20° of heading, and
- (when navigating) the route geometry passes within 30 m of the sensor's segment, which beats the cone check.

Alert level = highest status among sensors ahead: `caution` → yellow card, `flooded` → red full-width alert with sound/vibration. Distance counts down from the client's own GPS; the server only needs to answer "what is ahead" and push changes.

**Stalled vehicle overrides the radius.** A `stalled_vehicle` hazard alerts every driver whose route crosses it, or who is heading toward it on the same road within 2.5 km, immediately. This is the demo's "second car" moment.

Dismiss is per level: dismissing a yellow alert does not suppress a later red one.

## 5. Routing around floods

`POST /v1/routes {from, to}`:
1. Ask a routing engine for the fastest route plus alternatives.
2. For each route, find sensor segments within 30 m → `crosses[]`.
3. A route is unsafe if it crosses any `flooded` or `offline` sensor or an active hazard.
4. If the fastest is unsafe and no alternative is safe, request again with those segments excluded (most engines support avoid points or areas; check your provider's docs).
5. Return `fastest` (flagged) and `safer` with `delta_vs_fastest_s`.

The client re-requests when a `sensor.status_changed` affects a sensor in its current route's `crosses[]` and shows "Route recalculated, +N min".

For the hackathon, a hard-coded detour for the demo corridor is acceptable as a fallback (see `data/demo_scenario.json → routes.safer`).

## 6. Analytics (Analytics panel)

For range `1h | 6h | 24h`, ending now:

| Stat | Definition |
|---|---|
| Series | 120 buckets across the range (30 s / 3 min / 12 min); value = max depth in the bucket; null bucket = gap (offline) |
| Peak | max depth in range + its time |
| Fastest rise | max 5-minute rate in range (cm/min) |
| Above caution | minutes with depth ≥ 10 cm |
| Flooded | minutes with depth ≥ 30 cm |
| Status changes | last 24 h, newest first, max 5 shown |

Use max (not avg) per bucket so short peaks show on the chart. Chart y-axis max = max(35 cm, peak × 1.15); caution and flooded lines drawn at 10 and 30.

## 7. Demo mode

The stage demo must run without real rain. Replay `data/demo_scenario.json`:
- A server job emits readings for FR-07 every demo second through the **real ingest path** (so status, events, alerts and routing are real). Other sensors follow `readings_24h.csv` profiles.
- Demo time runs at `speed` × real time; 1 demo second represents 10 real seconds for timestamps.
- `POST /v1/demo/stall` creates a `stalled_vehicle` hazard at FR-07 with `source=demo`.
- `POST /v1/demo/reset` deletes `source=demo` readings, hazards and status changes after the demo start.
- The demo car's position is client-side (`reference/sim.js → demoCar`); the server doesn't need to know about it unless you want the projector and a phone in sync. In that case broadcast `demo.tick {demo_s, mode}` and let both clients compute the car from it.
