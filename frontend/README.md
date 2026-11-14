# FloodRoute frontend

React + TypeScript + Vite + Leaflet. Implements every screen in `handoff/floodroute-handoff/screens/` against the backend's `/v1` API (`backend/API_V1.md`).

One app, two layouts, chosen by width (override with `?view=stage` / `?view=phone`):

| Layout | Width | What |
|---|---|---|
| **Stage** (A2-Stage) | ≥ 1024 px | Map + right panel tabs (Sensor analytics / All sensors / Alerts) + floating Demo panel. For the laptop/projector. |
| **Phone** (A2-Phone) | < 1024 px | Map, Drive and Alerts tabs; sensor card → analytics; Sensors list; Settings; Welcome; trip Summary. |

## Run

```bash
npm install
npm run dev            # http://localhost:5173 ; proxies /v1 (REST + WebSocket) to http://localhost:8000
BACKEND_URL=http://host:8000 npm run dev   # point the proxy elsewhere
npm run build          # → dist/
```

The backend must be running (see `backend/README.md`). In production Caddy serves `dist/` and proxies `/v1` on the same origin (`frontend/Dockerfile` + `backend/Caddyfile`), so there's no CORS and `wss://` works once the domain has TLS.

## Demo controls

Play / Pause / speed / Reset / Navigate↔Watch / Stalled car / Scripted flood call `POST /v1/demo/*`, which needs the backend's `ADMIN_TOKEN`. Open the app once with `?demo_key=<token>` (remembered on that device), or enter it when prompted after pressing Play. Every connected screen (projector + phones) follows the same server demo clock.

- **Scripted flood off** (default): the flood comes from the real tub sensor `water_tank_1`. Pour water.
- **Scripted flood on**: the backend replays the handoff's depth curve for `water_tank_1` (hardware backup).

## How it maps to the handoff

| Handoff | Here |
|---|---|
| Map pins, status shapes, colored segments | `components/FloodMap.tsx`, `components/icons.tsx` (✓ circle / ! triangle / ✕ octagon / dashed circle) |
| "Live · N s ago", reconnecting, *No live data* (A2-Offline-Conn) | `store.ts` (WebSocket `/v1/live`, 2 s heartbeat, 10 s watchdog, backoff reconnect), `Overlays.tsx` → `LivePill`, `ConnBanner` |
| Sensor card + Analytics (1 h / 6 h / 24 h chart, peak, fastest rise, minutes above caution/flooded, status changes, health), Offline sensor | `components/SensorPanel.tsx` |
| All sensors (Most at risk / Nearest / On my route), Alerts feed (All / Near me / My routes / Following) | `components/Lists.tsx` |
| Drive: Navigate (route, turn banner, auto reroute + "Route recalculated, +N min", arrival summary) and Watch only (look-ahead cone), caution / flooded / stalled alerts, sound + vibration | `drive.tsx` (engine), `Overlays.tsx` (`AlertOverlay`, `NavBanner`, `RouteCard`, `ToastView`), `Screens.tsx` (`DriveSheet`, `Summary`) |
| Settings (look-ahead 500 m / 1 km / 2 km, alert types, sound, vibration, avoid offline, units), Welcome | `components/Screens.tsx` (stored in localStorage) |
| Demo panel (stage + phone compact row) | `Overlays.tsx` → `DemoPanel` |

Look-ahead rules (handoff `logic.md` §4) run client-side: while navigating, a sensor is "ahead" only if the route passes it; in Watch mode, if it's within the look-ahead radius and ±20° of heading. A stalled car overrides the radius (up to 2.5 km). Dismissing a yellow alert doesn't suppress a later red one. Thresholds come from `/v1/config`, so the chart lines and copy follow whatever the backend is tuned to.

## Notes

- Basemap: standard OpenStreetMap tiles, desaturated in CSS to the design's grey. Fine for demo traffic; for real use switch to a tile provider with a key.
- "Where to?" search uses OSM Nominatim (bounded to the map area, debounced), plus the demo destination and sensor names; you can also drop a pin on the map.
- Outside the demo, *Allow and start* uses the browser's GPS for the car position.
