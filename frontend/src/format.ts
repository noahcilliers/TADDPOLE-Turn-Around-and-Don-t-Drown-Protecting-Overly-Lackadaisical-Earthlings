import type { Status } from './types'

export const STATUS_LABEL: Record<Status, string> = { clear: 'Clear', caution: 'Rising', flooded: 'Flooded', offline: 'Offline' }
export const STATUS_RANK: Record<Status, number> = { flooded: 0, caution: 1, offline: 2, clear: 3 }

export const cmToIn = (cm: number) => cm / 2.54
export const fmtIn = (cm: number) => `${cmToIn(cm).toFixed(1)} in`
export const fmtCm = (cm: number) => `${Math.round(cm)} cm`

/** "~2 ft" once depth reaches 27 cm (design rule). */
export function feetHint(cm: number | null): string | null {
  if (cm == null || cm < 27) return null
  const ft = Math.round((cm / 30.48) * 2) / 2
  return `~${ft % 1 ? ft.toFixed(1) : ft.toFixed(0)} ft`
}

export function trend(rate: number | null): { label: string; dir: 'up' | 'down' | 'flat' } {
  if (rate == null) return { label: 'Steady', dir: 'flat' }
  if (rate > 0.3) return { label: `+${rate.toFixed(1)} cm/min`, dir: 'up' }
  if (rate < -0.3) return { label: `Falling ${Math.abs(rate).toFixed(1)} cm/min`, dir: 'down' }
  return { label: 'Steady', dir: 'flat' }
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s} s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

export function minsSince(iso: string | null | undefined, now = Date.now()): number | null {
  return iso ? Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000)) : null
}

export const metresToMiles = (m: number) => m / 1609.344
export function fmtMiles(m: number): string {
  const mi = metresToMiles(m)
  return mi < 1 ? mi.toFixed(2) : mi.toFixed(1)
}

export function fmtDuration(s: number): string {
  const m = Math.max(1, Math.round(s / 60))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

/** Phoenix local clock (UTC−7, no DST). */
export function clock(iso: string | Date, withDay = false): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' })
  if (!withDay) return t
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'America/Phoenix' })
  const that = d.toLocaleDateString('en-US', { timeZone: 'America/Phoenix' })
  const yest = new Date(Date.now() - 86_400_000).toLocaleDateString('en-US', { timeZone: 'America/Phoenix' })
  return that === today ? t : that === yest ? `Yest. ${t}` : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Phoenix' })} ${t}`
}

export function depthText(cm: number | null, units: 'both' | 'in' | 'cm'): { big: string; unit: string; small: string | null } {
  if (cm == null) return { big: '—', unit: '', small: null }
  if (units === 'in') return { big: cmToIn(cm).toFixed(1), unit: 'in', small: feetHint(cm) }
  const small = units === 'cm' ? feetHint(cm) : [fmtIn(cm), feetHint(cm)].filter(Boolean).join(' · ')
  return { big: String(Math.round(cm)), unit: 'cm', small }
}
