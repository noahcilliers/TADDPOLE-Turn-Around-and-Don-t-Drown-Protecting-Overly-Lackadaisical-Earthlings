// Shapes from backend/API_V1.md. Coordinates are [lng, lat].
export type Status = 'clear' | 'caution' | 'flooded' | 'offline'
export type LngLat = [number, number]

export interface Point { type: 'Point'; coordinates: LngLat }
export interface Line { type: 'LineString'; coordinates: LngLat[] }

export interface SensorState {
  status: Status
  depth_cm: number | null
  rate_cm_per_min: number | null
  last_reading_at: string | null
  status_since: string | null
}

export interface Sensor {
  id: string
  name: string
  road: string | null
  simulated: boolean
  location: Point
  segment: Line | null
  battery_pct: number | null
  signal: 'strong' | 'good' | 'weak' | 'lost' | null
  calibrated_at: string | null
  distance_m?: number
  current: SensorState
}

export interface Config {
  thresholds: { caution_cm: number; flooded_cm: number }
  offline_after_s: number
  bounds: [number, number, number, number] | null
  demo: { from: LngLat; to: LngLat; destination_name: string; stall_lnglat: LngLat; sensor_id: string }
}

export type Range = '1h' | '6h' | '24h'
export interface Series { range: Range; bucket_s: number; points: { t: string; depth_cm: number | null }[] }
export interface Stats {
  peak_cm: number | null
  peak_at: string | null
  fastest_rise_cm_per_min: number | null
  minutes_above_caution: number | null
  minutes_flooded: number | null
}
export interface StatusChange { time: string; from_status: Status | null; to_status: Status; depth_cm: number | null }

export interface FeedEvent {
  id: string
  time: string
  kind: 'status_change' | 'hazard' | 'local'
  sensor_id: string | null
  title: string
  from_status?: Status | null
  to_status?: Status
  hazard_kind?: string
  depth_cm: number | null
  detail: string
  // client-only items ("You were warned", "Route recalculated", ...)
  local?: { icon: 'shield' | 'warn' | 'flag'; tone: 'blue' | 'red' | 'yellow' | 'green' }
}

export interface Cross { sensor_id: string; name: string; status: Status; depth_cm: number | null; at_distance_m: number }
export interface Step { instruction: string; road: string; distance_m: number }
export interface Route {
  id: string
  kind: 'fastest' | 'safer'
  duration_s: number
  distance_m: number
  safe: boolean
  geometry: Line
  crosses: Cross[]
  steps: Step[]
  delta_vs_fastest_s?: number
}
export interface RoutesResponse { recommended: string; routes: Route[] }

export interface Hazard {
  id: string
  kind: 'stalled_vehicle' | string
  sensor_id: string | null
  location: Point
  source: 'driver' | 'demo' | 'operator' | 'sensor'
  created_at: string
  expires_at: string
}

export interface DemoSession {
  state: 'idle' | 'playing' | 'paused'
  mode: 'nav' | 'watch'
  speed: number
  demo_s: number
  at: string
  scripted: boolean
  stall: boolean
  duration_s: number   // scripted water curve length
  max_s?: number       // demo clock limit (older backends: duration_s)
}

export type LiveMsg =
  | { type: 'hello'; time: string; sensors: Sensor[]; hazards: Hazard[]; demo: DemoSession; config: Config }
  | { type: 'heartbeat'; time: string }
  | { type: 'sensor.reading'; time: string; sensor: Sensor }
  | { type: 'sensor.status_changed'; time: string; sensor_id: string; from: Status; to: Status; depth_cm: number | null; sensor: Sensor }
  | { type: 'hazard.created'; hazard: Hazard }
  | { type: 'hazard.cleared'; hazard_id: string; reason: string }
  | { type: 'demo.state'; demo: DemoSession }
  | { type: 'pong' }
