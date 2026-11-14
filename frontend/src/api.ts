import type { Config, DemoSession, FeedEvent, Hazard, LngLat, Range, RoutesResponse, Sensor, Series, Stats, StatusChange } from './types'

// Same origin by default (Vite proxy in dev, Caddy in prod). Override with VITE_API_BASE.
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? ''

export function liveUrl(): string {
  if (API_BASE) return API_BASE.replace(/^http/, 'ws') + '/v1/live'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/v1/live`
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function req<T>(path: string, init?: RequestInit & { admin?: boolean }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (init?.admin) headers['X-Admin-Token'] = getDemoKey()
  const res = await fetch(API_BASE + path, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } })
  if (!res.ok) {
    let msg = res.statusText
    try { const j = await res.json(); msg = j?.detail ?? j?.error?.message ?? msg } catch { /* not json */ }
    throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

const post = <T>(path: string, body: unknown, admin = false) => req<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}), admin })

// Demo/operator key: from ?demo_key=… once, then remembered on this device.
const KEY = 'floodroute.demoKey'
export function getDemoKey(): string {
  try {
    const fromUrl = new URLSearchParams(location.search).get('demo_key')
    if (fromUrl) localStorage.setItem(KEY, fromUrl)
    return localStorage.getItem(KEY) ?? ''
  } catch { return '' }
}
export function setDemoKey(v: string) { try { localStorage.setItem(KEY, v) } catch { /* private mode */ } }

export const api = {
  config: () => req<Config>('/v1/config'),
  sensors: (near?: LngLat, sort: 'risk' | 'near' = 'risk') =>
    req<Sensor[]>(`/v1/sensors?sort=${sort}${near ? `&near=${near[0]},${near[1]}` : ''}`),
  series: (id: string, range: Range) => req<Series>(`/v1/sensors/${encodeURIComponent(id)}/series?range=${range}`),
  stats: (id: string, range: Range) => req<Stats>(`/v1/sensors/${encodeURIComponent(id)}/stats?range=${range}`),
  statusChanges: (id: string) => req<StatusChange[]>(`/v1/sensors/${encodeURIComponent(id)}/status-changes?since=24h&limit=5`),
  events: (since = '24h', limit = 60) => req<FeedEvent[]>(`/v1/events?since=${since}&limit=${limit}`),
  routes: (from: LngLat, to: LngLat, avoid_offline = true) => post<RoutesResponse>('/v1/routes', { from, to, avoid_offline }),
  reportStall: (location: LngLat) => post<Hazard>('/v1/hazards', { kind: 'stalled_vehicle', location, source: 'driver' }),
  demo: {
    get: () => req<DemoSession>('/v1/demo'),
    start: (mode?: 'nav' | 'watch', speed?: number) => post<DemoSession>('/v1/demo/start', { mode, speed }, true),
    pause: () => post<DemoSession>('/v1/demo/pause', {}, true),
    speed: (speed: number) => post<DemoSession>('/v1/demo/speed', { speed }, true),
    mode: (mode: 'nav' | 'watch') => post<DemoSession>('/v1/demo/mode', { mode }, true),
    scripted: (enabled: boolean) => post<DemoSession>('/v1/demo/scripted', { enabled }, true),
    stall: (enabled: boolean) => post<DemoSession>('/v1/demo/stall', { enabled }, true),
    reset: () => post<DemoSession>('/v1/demo/reset', {}, true),
  },
}
