/* Drive engine: one instance shared by Stage and Phone layouts.
 *
 * - Car position: the demo car (driven by the server's demo clock, so projector and
 *   phone stay in sync) or, outside the demo, the browser's GPS.
 * - Navigate: follows the recommended route from POST /v1/routes; re-requests when a
 *   sensor it crosses changes status or a hazard appears, and shows "Route recalculated".
 * - Watch only: no destination; warns about hazards ahead (cone + on-road) within the
 *   look-ahead radius. A stalled car overrides the radius (handoff logic.md §4).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import { along, angleDiff, bearing, dist, lineLength, project, sliceFrom } from './geo'
import { fmtDuration, feetHint } from './format'
import { onDomainEvent, pushLocal, store, useStore } from './store'
import type { DemoSession, Hazard, LngLat, Route, RoutesResponse, Sensor } from './types'

// Demo choreography from handoff reference/sim.js (grid miles → metres).
const NAV_SPEED_M_PER_DEMO_S = 0.03 * 1609.344   // ≈ 48 m per demo second
const WATCH_SPEED_M_PER_DEMO_S = 0.012 * 1609.344 // ≈ 19 m per demo second
const WATCH_START: LngLat = [-111.99532, 33.49492]  // 40th St at Indian School, heading north
const WATCH_STOP_SHORT_M = 0.25 * 1609.344          // watch car stops 0.25 mi before the dip
const STOP_BEFORE_HAZARD_M = 90                      // drivers stop short of water they were warned about
const STALL_RADIUS_M = 2500
const CONE_DEG = 20
const ON_ROUTE_M = 35

export type AlertLevel = 'caution' | 'flooded' | 'stalled'
export interface DriveAlert {
  level: AlertLevel
  sensor: Sensor | null
  hazard: Hazard | null
  distance_m: number
  closing_s: number | null
  key: string
}
export interface Toast { id: number; title: string; detail: string; tone: 'blue' | 'green' }
export interface TripSummary {
  destination: string
  duration_s: number
  distance_m: number
  delta_s: number
  avoided: { name: string; depth_cm: number | null }[]
  passed: { name: string; status: string; depth_cm: number | null }[]
  reroutes: string[]
  arrived_at: string
}

export interface DriveApi {
  mode: 'nav' | 'watch'
  setMode: (m: 'nav' | 'watch') => void
  destination: { lnglat: LngLat; name: string } | null
  setDestination: (d: { lnglat: LngLat; name: string } | null) => void
  origin: LngLat | null
  routes: RoutesResponse | null
  active: Route | null
  abandoned: LngLat[] | null
  remaining: LngLat[] | null
  car: { pos: LngLat; heading: number } | null
  traveled_m: number
  alert: DriveAlert | null
  dismissAlert: () => void
  rerouteNow: () => void
  toast: Toast | null
  arrived: TripSummary | null
  clearArrived: () => void
  demoActive: boolean
  demoS: number
  routeError: string | null
  gps: { enabled: boolean; error: string | null }
  enableGps: () => void
}

const Ctx = createContext<DriveApi | null>(null)
export const useDrive = () => {
  const v = useContext(Ctx)
  if (!v) throw new Error('useDrive outside DriveProvider')
  return v
}

/** Current demo second, extrapolated locally from the last demo.state we received. */
export function useDemoClock(): number {
  const live = useStore((s) => s.demo)
  // `base` = the demo snapshot and the local time we received it; `now` ticks while playing.
  const [base, setBase] = useState<{ demo: DemoSession | null; t0: number }>({ demo: null, t0: 0 })
  const [now, setNow] = useState(0)
  useEffect(() => {
    const t = performance.now()
    setBase({ demo: live, t0: t })
    setNow(t)
  }, [live])
  useEffect(() => {
    if (live?.state !== 'playing') return
    const id = window.setInterval(() => setNow(performance.now()), 200)
    return () => window.clearInterval(id)
  }, [live?.state])
  const demo = base.demo
  if (!demo) return 0
  if (demo.state !== 'playing') return demo.demo_s
  return Math.min(demo.duration_s, demo.demo_s + (Math.max(0, now - base.t0) / 1000) * demo.speed)
}

function chime() {
  try {
    const ctx = new AudioContext()
    const t = ctx.currentTime
    ;[880, 660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.frequency.value = f; o.type = 'sine'
      g.gain.setValueAtTime(0.0001, t + i * 0.22)
      g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.22 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.22 + 0.2)
      o.connect(g).connect(ctx.destination); o.start(t + i * 0.22); o.stop(t + i * 0.22 + 0.21)
    })
    setTimeout(() => ctx.close(), 1200)
  } catch { /* audio blocked until user gesture */ }
}

function recommended(r: RoutesResponse | null): Route | null {
  if (!r) return null
  return r.routes.find((x) => x.id === r.recommended) ?? r.routes[0] ?? null
}

export function DriveProvider({ children }: { children: ReactNode }) {
  const config = useStore((s) => s.config)
  const demo = useStore((s) => s.demo)
  const sensorsMap = useStore((s) => s.sensors)
  const hazardsMap = useStore((s) => s.hazards)
  const settings = useStore((s) => s.settings)
  const demoS = useDemoClock()

  const [mode, setModeState] = useState<'nav' | 'watch'>('nav')
  const [destination, setDestination] = useState<{ lnglat: LngLat; name: string } | null>(null)
  const [routes, setRoutes] = useState<RoutesResponse | null>(null)
  const [active, setActive] = useState<Route | null>(null)
  const [abandoned, setAbandoned] = useState<LngLat[] | null>(null)
  const [pathStart, setPathStart] = useState<{ demoS: number; offset_m: number }>({ demoS: 0, offset_m: 0 })
  const [toast, setToast] = useState<Toast | null>(null)
  const [arrived, setArrived] = useState<TripSummary | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [routeError, setRouteError] = useState<string | null>(null)
  const [gpsState, setGps] = useState<{ enabled: boolean; error: string | null; pos: LngLat | null; heading: number | null }>({ enabled: false, error: null, pos: null, heading: null })
  const trip = useRef<{ startedS: number; reroutes: string[]; avoided: Map<string, number | null>; baseDuration: number | null; warned: Set<string> }>({ startedS: 0, reroutes: [], avoided: new Map(), baseDuration: null, warned: new Set() })
  const lastDemoS = useRef(0)
  const toastId = useRef(0)

  const demoActive = !!demo && (demo.state !== 'idle' || demo.demo_s > 0)

  // Follow the server's demo mode so projector and phone agree.
  useEffect(() => { if (demo?.mode) setModeState(demo.mode) }, [demo?.mode])
  const setMode = useCallback((m: 'nav' | 'watch') => {
    setModeState(m)
    if (store.get().demo) api.demo.mode(m).catch(() => { /* no demo key: local only */ })
  }, [])

  // Default destination = the demo destination.
  useEffect(() => {
    if (config && !destination) setDestination({ lnglat: config.demo.to, name: config.demo.destination_name })
  }, [config, destination])

  const showToast = useCallback((title: string, detail: string, tone: Toast['tone'] = 'blue') => {
    const id = ++toastId.current
    setToast({ id, title, detail, tone })
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 6500)
  }, [])

  // ---------- origin + car ----------
  const origin: LngLat | null = useMemo(() => {
    if (!config) return null
    if (!demoActive && gpsState.pos) return gpsState.pos
    return mode === 'watch' ? WATCH_START : config.demo.from
  }, [config, demoActive, gpsState.pos, mode])

  const fetchRoutes = useCallback(async (from: LngLat, to: LngLat) => {
    try {
      const r = await api.routes(from, to, store.get().settings.avoid_offline)
      setRouteError(null)
      return r
    } catch (e) {
      setRouteError(e instanceof Error ? e.message : 'Routing unavailable')
      return null
    }
  }, [])

  // (Re)plan the trip from the origin whenever the trip itself changes (mode, destination, demo reset).
  const planKey = `${mode}|${destination?.lnglat.join(',')}|${origin?.join(',')}|${config ? 1 : 0}`
  const [resetCounter, setResetCounter] = useState(0)
  useEffect(() => {
    if (demoS + 0.5 < lastDemoS.current) setResetCounter((n) => n + 1) // demo reset / rewind
    lastDemoS.current = demoS
  }, [demoS])

  useEffect(() => {
    let cancelled = false
    if (!origin || !destination) return
    setAbandoned(null); setArrived(null); setDismissed(new Set())
    trip.current = { startedS: demoS, reroutes: [], avoided: new Map(), baseDuration: null, warned: new Set() }
    void fetchRoutes(origin, destination.lnglat).then((r) => {
      if (cancelled || !r) return
      setRoutes(r)
      // Watch mode drives the plain road ahead (fastest), it doesn't navigate around anything.
      const chosen = mode === 'watch' ? r.routes.find((x) => x.kind === 'fastest') ?? recommended(r) : recommended(r)
      setActive(chosen)
      trip.current.baseDuration = r.routes.find((x) => x.kind === 'fastest')?.duration_s ?? null
      // Planned from the trip origin: the demo car's position is demo_s × speed along this path.
      setPathStart({ demoS: 0, offset_m: 0 })
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, resetCounter])

  // GPS (outside the demo)
  const enableGps = useCallback(() => {
    if (!('geolocation' in navigator)) { setGps((g) => ({ ...g, error: 'Location not available on this device' })); return }
    navigator.geolocation.watchPosition(
      (p) => setGps({ enabled: true, error: null, pos: [p.coords.longitude, p.coords.latitude], heading: p.coords.heading ?? null }),
      (e) => setGps((g) => ({ ...g, enabled: false, error: e.message })),
      { enableHighAccuracy: true, maximumAge: 2000 },
    )
  }, [])

  const path = active?.geometry.coordinates ?? null
  const pathLen = useMemo(() => (path ? lineLength(path) : 0), [path])

  // Where along the active path is the car?
  const { car, traveled } = useMemo(() => {
    if (!path || path.length < 2) return { car: null as DriveApi['car'], traveled: 0 }
    if (!demoActive) {
      if (gpsState.pos) {
        const pr = project(path, gpsState.pos)
        const h = gpsState.heading ?? along(path, pr.along_m).heading
        return { car: { pos: gpsState.pos, heading: h }, traveled: pr.along_m }
      }
      const a = along(path, 0)
      return { car: { pos: a.pos, heading: a.heading }, traveled: 0 }
    }
    const v = mode === 'nav' ? NAV_SPEED_M_PER_DEMO_S : WATCH_SPEED_M_PER_DEMO_S
    let d = pathStart.offset_m + Math.max(0, demoS - pathStart.demoS) * v
    // Watch car stops 0.25 mi before the demo dip (sim.js choreography).
    if (mode === 'watch' && config) {
      const s = sensorsMap[config.demo.sensor_id]
      if (s) {
        const pr = project(path, s.location.coordinates)
        if (pr.off_m < 60) d = Math.min(d, Math.max(0, pr.along_m - WATCH_STOP_SHORT_M))
      }
    }
    // Any driver stops short of flooded water or a stalled car on their path.
    for (const s of Object.values(sensorsMap)) {
      if (s.current.status !== 'flooded') continue
      const pr = project(path, s.location.coordinates)
      if (pr.off_m < ON_ROUTE_M && pr.along_m > d - 5) d = Math.min(d, Math.max(0, pr.along_m - STOP_BEFORE_HAZARD_M))
    }
    for (const h of Object.values(hazardsMap)) {
      const pr = project(path, h.location.coordinates)
      if (pr.off_m < ON_ROUTE_M && pr.along_m > d - 5) d = Math.min(d, Math.max(0, pr.along_m - STOP_BEFORE_HAZARD_M))
    }
    d = Math.min(d, pathLen)
    const a = along(path, d)
    return { car: { pos: a.pos, heading: a.heading }, traveled: d }
  }, [path, pathLen, demoActive, demoS, pathStart, mode, config, sensorsMap, hazardsMap, gpsState.pos, gpsState.heading])

  // ---------- reroute ----------
  const carRef = useRef(car); carRef.current = car
  const activeRef = useRef(active); activeRef.current = active
  const traveledRef = useRef(traveled); traveledRef.current = traveled
  const demoSRef = useRef(demoS); demoSRef.current = demoS
  const rerouting = useRef(false)

  const reroute = useCallback(async (reason: Sensor | Hazard | null, forceToast = false) => {
    if (rerouting.current || !destination) return
    const from = carRef.current?.pos ?? origin
    if (!from) return
    rerouting.current = true
    try {
      const r = await fetchRoutes(from, destination.lnglat)
      if (!r) return
      const next = recommended(r)
      const prev = activeRef.current
      setRoutes(r)
      if (!next) return
      const prevRemaining = prev ? sliceFrom(prev.geometry.coordinates, traveledRef.current) : null
      const changed = !prev || JSON.stringify(next.geometry.coordinates.slice(-3)) !== JSON.stringify(prevRemaining?.slice(-3)) ||
        Math.abs(lineLength(next.geometry.coordinates) - (prevRemaining ? lineLength(prevRemaining) : 0)) > 25
      if (!changed && !forceToast) return
      setAbandoned(prevRemaining && changed ? prevRemaining : null)
      setActive(next)
      setPathStart({ demoS: demoSRef.current, offset_m: 0 })
      if (next.kind === 'safer' || !next.safe || forceToast) {
        const avoided = r.routes.find((x) => x.kind === 'fastest')?.crosses.filter((c) => c.status === 'flooded' || c.status === 'offline') ?? []
        avoided.forEach((c) => trip.current.avoided.set(c.sensor_id, c.depth_cm))
        const name = avoided[0]?.name ?? (reason && 'name' in reason ? reason.name : 'a flooded road')
        const delta = next.delta_vs_fastest_s ?? 0
        const what = reason && 'kind' in reason ? 'stalled car' : 'flooded dip'
        const detail = next.safe ? `+${Math.max(1, Math.round(delta / 60))} min, avoids ${what} at ${name}` : 'No flood-free route right now. Wait or turn around.'
        showToast('Route recalculated', detail)
        trip.current.reroutes.push(new Date().toISOString())
        pushLocal('Route recalculated', detail, { icon: 'shield', tone: 'blue' })
      } else if (prev && prev.kind === 'safer' && next.kind === 'fastest') {
        showToast('Road reopened', 'Back on the fastest route', 'green')
      }
    } finally { rerouting.current = false }
  }, [destination, origin, fetchRoutes, showToast])

  // React to live events that touch our route.
  useEffect(() => onDomainEvent((e) => {
    if (mode !== 'nav' || !activeRef.current) return
    const route = activeRef.current
    if (e.kind === 'status_changed') {
      const crosses = route.crosses.some((c) => c.sensor_id === e.sensor.id)
      const becameUnsafe = e.to === 'flooded' || (e.to === 'offline' && store.get().settings.avoid_offline)
      const becameSafe = e.from === 'flooded' || e.from === 'offline'
      if ((crosses && becameUnsafe) || (becameSafe && trip.current.avoided.has(e.sensor.id))) void reroute(e.sensor)
    } else if (e.kind === 'hazard_created') {
      const pr = project(route.geometry.coordinates, e.hazard.location.coordinates)
      if (pr.off_m < 60 && pr.along_m > traveledRef.current) void reroute(e.hazard)
    }
  }), [mode, reroute])

  // ---------- look-ahead alert ----------
  const alert: DriveAlert | null = useMemo(() => {
    if (!car) return null
    const sensors = Object.values(sensorsMap)
    const hazards = Object.values(hazardsMap)
    const speed = demoActive && demo?.state === 'playing' ? (mode === 'nav' ? NAV_SPEED_M_PER_DEMO_S : WATCH_SPEED_M_PER_DEMO_S) * (demo?.speed ?? 1) : null

    const aheadDist = (p: LngLat): number | null => {
      if (path) {
        const pr = project(path, p)
        if (pr.off_m < ON_ROUTE_M && pr.along_m >= traveled - 5) return Math.max(0, pr.along_m - traveled)
      }
      const d = dist(car.pos, p)
      if (d > 15 && angleDiff(bearing(car.pos, p), car.heading) <= CONE_DEG) return d
      return null
    }

    // stalled car beats everything and ignores the radius
    if (settings.alert_stalled) {
      for (const h of hazards) {
        const d = aheadDist(h.location.coordinates)
        if (d != null && d <= STALL_RADIUS_M) {
          const s = h.sensor_id ? sensorsMap[h.sensor_id] ?? null : null
          return { level: 'stalled', sensor: s, hazard: h, distance_m: d, closing_s: speed ? d / speed : null, key: `stalled:${h.id}` }
        }
      }
    }
    let best: DriveAlert | null = null
    for (const s of sensors) {
      const st = s.current.status
      if (st !== 'flooded' && st !== 'caution') continue
      if (st === 'flooded' && !settings.alert_flooded) continue
      if (st === 'caution' && !settings.alert_rising) continue
      const d = aheadDist(s.location.coordinates)
      if (d == null || d > settings.lookahead_m) continue
      const cand: DriveAlert = { level: st, sensor: s, hazard: null, distance_m: d, closing_s: speed ? d / speed : null, key: `${st}:${s.id}` }
      if (!best || (cand.level === 'flooded' && best.level !== 'flooded') || (cand.level === best.level && d < best.distance_m)) best = cand
    }
    return best
  }, [car, sensorsMap, hazardsMap, path, traveled, settings, demoActive, demo?.state, demo?.speed, mode])

  const visibleAlert = alert && !dismissed.has(alert.key) ? alert : null

  // side effects of a new alert: sound, vibration, feed entries
  const lastAlertKey = useRef<string | null>(null)
  useEffect(() => {
    const k = visibleAlert?.key ?? null
    if (k === lastAlertKey.current) return
    lastAlertKey.current = k
    if (!visibleAlert || trip.current.warned.has(visibleAlert.key)) return
    trip.current.warned.add(visibleAlert.key)
    const { level, sensor, distance_m } = visibleAlert
    const mi = (distance_m / 1609.344).toFixed(2)
    if (level !== 'caution') {
      if (store.get().settings.sound) chime()
      if (store.get().settings.vibration) navigator.vibrate?.([300, 120, 300])
    }
    if (level === 'caution') pushLocal('You were warned', `Rising water ${mi} mi ahead · ${sensor?.name ?? ''}`, { icon: 'shield', tone: 'yellow' }, sensor?.id ?? null)
    else if (level === 'flooded') pushLocal('Warning escalated', `Flooded ${mi} mi ahead · Turn around, don't drown`, { icon: 'shield', tone: 'red' }, sensor?.id ?? null)
    else pushLocal('Car behind warned instantly', `Stalled car ${mi} mi ahead${sensor ? ' at ' + sensor.name : ''}`, { icon: 'shield', tone: 'red' }, sensor?.id ?? null)
  }, [visibleAlert])

  // ---------- arrival ----------
  useEffect(() => {
    if (mode !== 'nav' || !active || !demoActive || arrived) return
    if (traveled < pathLen - 3 || pathLen === 0) return
    const fastest = routes?.routes.find((r) => r.kind === 'fastest')
    const total = (demoS - trip.current.startedS) * 10 // 1 demo s = 10 real s (handoff)
    const summary: TripSummary = {
      destination: destination?.name ?? 'Destination',
      duration_s: Math.max(active.duration_s, total),
      distance_m: lineLength(active.geometry.coordinates) + (abandoned ? 0 : 0),
      delta_s: trip.current.baseDuration ? Math.max(0, Math.round((active.duration_s) - (fastest?.duration_s ?? active.duration_s))) : 0,
      avoided: [...trip.current.avoided.entries()].map(([id, d]) => ({ name: sensorsMap[id]?.name ?? id, depth_cm: sensorsMap[id]?.current.depth_cm ?? d })),
      passed: active.crosses.map((c) => ({ name: c.name, status: sensorsMap[c.sensor_id]?.current.status ?? c.status, depth_cm: sensorsMap[c.sensor_id]?.current.depth_cm ?? c.depth_cm })),
      reroutes: trip.current.reroutes,
      arrived_at: new Date().toISOString(),
    }
    setArrived(summary)
    const avoidedTxt = summary.avoided.length ? `Avoided ${summary.avoided.length} flooded dip${summary.avoided.length > 1 ? 's' : ''}` : 'No hazards on the way'
    showToast('You arrived safely', `${avoidedTxt}${summary.reroutes.length ? ` · ${fmtDuration(Math.max(60, summary.delta_s))} extra` : ''}`, 'green')
    pushLocal('Arrived safely', avoidedTxt, { icon: 'flag', tone: 'green' })
  }, [traveled, pathLen, mode, active, demoActive, arrived, routes, demoS, destination, abandoned, sensorsMap, showToast])

  const value: DriveApi = {
    mode, setMode, destination,
    setDestination: (d) => { setDestination(d); setAbandoned(null) },
    origin, routes, active, abandoned,
    remaining: path ? sliceFrom(path, traveled) : null,
    car, traveled_m: traveled,
    alert: visibleAlert,
    dismissAlert: () => { if (visibleAlert) setDismissed((s) => new Set(s).add(visibleAlert.key)) },
    rerouteNow: () => { if (visibleAlert) setDismissed((s) => new Set(s).add(visibleAlert.key)); setModeState('nav'); void reroute(visibleAlert?.sensor ?? visibleAlert?.hazard ?? null, true) },
    toast, arrived, clearArrived: () => setArrived(null),
    demoActive, demoS, routeError,
    gps: { enabled: gpsState.enabled, error: gpsState.error }, enableGps,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function alertHeadline(a: DriveAlert): { title: string; sub: string } {
  const name = a.sensor?.name ?? 'the road ahead'
  const d = a.sensor?.current.depth_cm ?? null
  const ft = feetHint(d)
  if (a.level === 'stalled') return { title: 'Car stalled ahead', sub: `A vehicle is stuck in the water at ${name}` }
  if (a.level === 'flooded') return { title: 'Flooded ahead', sub: `${ft ?? (d != null ? `${Math.round(d)} cm` : 'Deep water')} deep at ${name}` }
  return { title: 'Water rising ahead', sub: name }
}
