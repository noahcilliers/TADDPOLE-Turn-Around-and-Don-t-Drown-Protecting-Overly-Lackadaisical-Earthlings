import type { LngLat } from './types'

const R = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export function dist(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Initial bearing a→b, degrees clockwise from north. */
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]))
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]))
  return (deg(Math.atan2(y, x)) + 360) % 360
}

export const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180)

export function lineLength(coords: LngLat[]): number {
  let L = 0
  for (let i = 1; i < coords.length; i++) L += dist(coords[i - 1], coords[i])
  return L
}

/** Point + heading at distance d (m) along the line (clamped). */
export function along(coords: LngLat[], d: number): { pos: LngLat; heading: number; done: boolean } {
  if (coords.length === 0) return { pos: [0, 0], heading: 0, done: true }
  if (coords.length === 1) return { pos: coords[0], heading: 0, done: true }
  let rem = Math.max(0, d)
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i], l = dist(a, b)
    if (rem <= l) {
      const f = l ? rem / l : 0
      return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], heading: bearing(a, b), done: false }
    }
    rem -= l
  }
  const n = coords.length
  return { pos: coords[n - 1], heading: bearing(coords[n - 2], coords[n - 1]), done: true }
}

/** Smoothed travel heading at distance d: bearing to the point `ahead` metres further on,
 *  so tiny or zero-length segments in the route geometry don't make the heading jump. */
export function headingAt(coords: LngLat[], d: number, ahead = 15): number {
  const here = along(coords, d), there = along(coords, d + ahead)
  return dist(here.pos, there.pos) > 1 ? bearing(here.pos, there.pos) : here.heading
}

/** Distance along the line of the point on it nearest to p, and how far p is from the line. */
export function project(coords: LngLat[], p: LngLat): { along_m: number; off_m: number } {
  // local equirectangular metres
  const kx = 111_320 * Math.cos(rad(p[1])), ky = 110_540
  let best = { along_m: 0, off_m: Infinity }, acc = 0
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i]
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0
    const off = Math.hypot(ax + t * dx, ay + t * dy)
    const seg = Math.sqrt(L2)
    if (off < best.off_m) best = { along_m: acc + t * seg, off_m: off }
    acc += seg
  }
  return best
}

/** Sub-line from distance d to the end (for drawing the remaining route). */
export function sliceFrom(coords: LngLat[], d: number): LngLat[] {
  if (coords.length < 2) return coords
  let rem = Math.max(0, d)
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i], l = dist(a, b)
    if (rem <= l) {
      const f = l ? rem / l : 0
      return [[a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], ...coords.slice(i)]
    }
    rem -= l
  }
  return [coords[coords.length - 1]]
}
