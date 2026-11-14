import { useSyncExternalStore } from 'react'
import { api, liveUrl } from './api'
import type { Config, DemoSession, FeedEvent, Hazard, LiveMsg, Sensor, Status } from './types'

export interface Settings {
  lookahead_m: 500 | 1000 | 2000
  alert_rising: boolean
  alert_flooded: boolean
  alert_stalled: boolean
  sound: boolean
  vibration: boolean
  units: 'both' | 'in' | 'cm'
  avoid_offline: boolean
  welcomed: boolean
  following: string[]
}

const DEFAULT_SETTINGS: Settings = {
  lookahead_m: 1000, alert_rising: true, alert_flooded: true, alert_stalled: true,
  sound: true, vibration: true, units: 'both', avoid_offline: true, welcomed: false, following: [],
}

export type ConnState = 'connecting' | 'live' | 'reconnecting'

export interface State {
  config: Config | null
  sensors: Record<string, Sensor>
  hazards: Record<string, Hazard>
  demo: DemoSession | null
  conn: ConnState
  lastMsgAt: number | null       // ms epoch of the last message of any kind
  feed: FeedEvent[]              // newest first
  settings: Settings
}

function loadSettings(): Settings {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('floodroute.settings') ?? '{}') } }
  catch { return DEFAULT_SETTINGS }
}

let state: State = {
  config: null, sensors: {}, hazards: {}, demo: null, conn: 'connecting', lastMsgAt: null, feed: [], settings: loadSettings(),
}
const listeners = new Set<() => void>()

function set(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export const store = {
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(state))
}

export function updateSettings(patch: Partial<Settings>) {
  const settings = { ...state.settings, ...patch }
  try { localStorage.setItem('floodroute.settings', JSON.stringify(settings)) } catch { /* private mode */ }
  set({ settings })
}

// ---------- domain events other modules react to (drive engine, toasts) ----------
export type DomainEvent =
  | { kind: 'status_changed'; sensor: Sensor; from: Status; to: Status }
  | { kind: 'hazard_created'; hazard: Hazard }
  | { kind: 'hazard_cleared'; id: string }
const domainListeners = new Set<(e: DomainEvent) => void>()
export function onDomainEvent(fn: (e: DomainEvent) => void) { domainListeners.add(fn); return () => { domainListeners.delete(fn) } }
const emit = (e: DomainEvent) => domainListeners.forEach((f) => f(e))

// ---------- feed ----------
const inches = (cm: number) => (cm / 2.54).toFixed(1)
export function pushFeed(e: FeedEvent) {
  if (state.feed.some((x) => x.id === e.id)) return
  set({ feed: [e, ...state.feed].slice(0, 200) })
}
export function pushLocal(title: string, detail: string, local: NonNullable<FeedEvent['local']>, sensor_id: string | null = null) {
  pushFeed({ id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, time: new Date().toISOString(), kind: 'local', sensor_id, title, detail, depth_cm: null, local })
}

export async function loadFeed() {
  try {
    const events = await api.events('24h', 80)
    const locals = state.feed.filter((e) => e.kind === 'local')
    const merged = [...locals, ...events].sort((a, b) => (a.time < b.time ? 1 : -1))
    set({ feed: merged })
  } catch { /* feed is best-effort; live events still arrive */ }
}

// ---------- live socket ----------
let ws: WebSocket | null = null
let retry = 0
let retryTimer: number | undefined

function handle(msg: LiveMsg) {
  const now = Date.now()
  switch (msg.type) {
    case 'hello': {
      const sensors: Record<string, Sensor> = {}
      msg.sensors.forEach((s) => (sensors[s.id] = s))
      const hazards: Record<string, Hazard> = {}
      msg.hazards.forEach((h) => (hazards[h.id] = h))
      set({ sensors, hazards, demo: msg.demo, config: msg.config, conn: 'live', lastMsgAt: now })
      void loadFeed()
      return
    }
    case 'heartbeat':
      set({ lastMsgAt: now, conn: 'live' })
      return
    case 'sensor.reading':
      set({ sensors: { ...state.sensors, [msg.sensor.id]: msg.sensor }, lastMsgAt: now })
      return
    case 'sensor.status_changed': {
      set({ sensors: { ...state.sensors, [msg.sensor.id]: msg.sensor }, lastMsgAt: now })
      const d = msg.depth_cm
      pushFeed({
        id: `ws_${msg.sensor_id}_${msg.time}`, time: msg.time, kind: 'status_change', sensor_id: msg.sensor_id,
        title: msg.sensor.name, from_status: msg.from, to_status: msg.to, depth_cm: d,
        detail: msg.to === 'offline' ? 'No reading from sensor' : d == null ? '' : `${Math.round(d)} cm · ${inches(d)} in`,
      })
      emit({ kind: 'status_changed', sensor: msg.sensor, from: msg.from, to: msg.to })
      return
    }
    case 'hazard.created': {
      set({ hazards: { ...state.hazards, [msg.hazard.id]: msg.hazard }, lastMsgAt: now })
      const s = msg.hazard.sensor_id ? state.sensors[msg.hazard.sensor_id] : undefined
      pushFeed({
        id: `hz_${msg.hazard.id}`, time: msg.hazard.created_at, kind: 'hazard', sensor_id: msg.hazard.sensor_id,
        title: 'Car stalled in water', hazard_kind: msg.hazard.kind, depth_cm: s?.current.depth_cm ?? null,
        detail: `${s ? s.name + ' · ' : ''}Reported by ${msg.hazard.source === 'driver' ? 'a driver' : 'the car ahead'}`,
      })
      emit({ kind: 'hazard_created', hazard: msg.hazard })
      return
    }
    case 'hazard.cleared': {
      const hazards = { ...state.hazards }
      delete hazards[msg.hazard_id]
      set({ hazards, lastMsgAt: now })
      emit({ kind: 'hazard_cleared', id: msg.hazard_id })
      return
    }
    case 'demo.state':
      set({ demo: msg.demo, lastMsgAt: now })
      return
    default:
      set({ lastMsgAt: now })
  }
}

export function connectLive() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  ws = new WebSocket(liveUrl())
  ws.onopen = () => { retry = 0 }
  ws.onmessage = (ev) => {
    try { handle(JSON.parse(ev.data) as LiveMsg) } catch (e) { console.warn('bad live message', e) }
  }
  ws.onclose = () => {
    set({ conn: state.lastMsgAt ? 'reconnecting' : 'connecting' })
    const delay = Math.min(10_000, 1000 * 2 ** retry++)
    window.clearTimeout(retryTimer)
    retryTimer = window.setTimeout(connectLive, delay)
  }
  ws.onerror = () => ws?.close()
}

export function reconnectNow() {
  retry = 0
  window.clearTimeout(retryTimer)
  try { ws?.close() } catch { /* ignore */ }
  ws = null
  connectLive()
}

// Optimistic local update for demo control responses (WS demo.state also arrives).
export function setDemo(demo: DemoSession) { set({ demo }) }

// Watchdog: no message for >10 s while "live" → show the reconnecting state.
setInterval(() => {
  if (state.conn === 'live' && state.lastMsgAt && Date.now() - state.lastMsgAt > 10_000) {
    set({ conn: 'reconnecting' })
    reconnectNow()
  }
}, 2000)
