import L from 'leaflet'

/* Trackpad pinch-to-zoom that follows the fingers, the way Leaflet's touch pinch does on phones.
 *
 * Browsers deliver a laptop trackpad pinch as a stream of tiny ctrl+wheel events (Chrome, Edge,
 * Firefox) or as gesturestart/change/end events (Safari). Leaflet's scroll-wheel handler turns
 * each batch of wheel deltas into one animated zoom step of at least `zoomSnap`, and drops every
 * request that arrives during that 250ms animation, so a pinch crawled along at about one zoom
 * level per second however fast you pinched. Here, each event moves the map straight to the new
 * zoom level (one redraw per frame), and only the final position snaps to `zoomSnap`. */

/** No wheel-pinch event for this long means the fingers have lifted. */
const PINCH_IDLE_MS = 120
/** Upper bound on one wheel event's deltaY (px), so a ctrl+mouse-wheel notch can't jump too far. */
const MAX_WHEEL_DELTA = 50

/** Leaflet internals that its own TouchZoom handler uses for pinching. */
type LeafletInternals = L.Map & {
  _animatingZoom: boolean
  _animateToZoom: number
  _stop(): void
  _limitZoom(zoom: number): number
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): void
  _move(center: L.LatLng, zoom: number, data: { pinch: boolean; round: boolean }): void
  _animateZoom(center: L.LatLng, zoom: number, startAnim: boolean, noUpdate: unknown): void
  _resetView(center: L.LatLng, zoom: number): void
}

/** Safari's non-standard GestureEvent. */
type GestureEvt = UIEvent & { scale: number; clientX: number; clientY: number }

/** Returns a function that removes the listeners. `onUse` runs on every pinch event.
 *  `anchor` (optional): a container point to zoom around instead of the cursor, e.g. the car
 *  while the map is following it. */
export function enableTrackpadPinch(map: L.Map, onUse: () => void, anchor?: () => L.Point | null): () => void {
  const m = map as LeafletInternals
  const container = m.getContainer()
  // Current pinch session; `center` is null when no pinch is in progress.
  let center: L.LatLng | null = null
  let zoom = 0
  let offset = L.point(0, 0) // cursor position relative to the map centre, in px
  let raf = 0
  let idle = 0
  let gesture = false // Safari gesture in progress
  let gestureBaseZoom = 0

  const draw = () => {
    raf = 0
    if (center) m._move(center, zoom, { pinch: true, round: false })
  }

  /** Centre that keeps the map point under the cursor fixed when going from (c, z) to `toZoom`. */
  const centerFor = (c: L.LatLng, z: number, toZoom: number) => {
    const underCursor = m.unproject(m.project(c, z).add(offset), z)
    return m.unproject(m.project(underCursor, toZoom).subtract(offset), toZoom)
  }

  const zoomTo = (target: number, clientX: number, clientY: number) => {
    if (!center) {
      // Leaflet's own zoom animation is still finishing: wait for it rather than fight it.
      if (m._animatingZoom) return
      m._stop()
      center = m.getCenter()
      zoom = m.getZoom()
      m._moveStart(true, false)
    }
    const rect = container.getBoundingClientRect()
    const a = anchor?.()
    offset = a ? a.subtract(L.point(rect.width / 2, rect.height / 2))
      : L.point(clientX - rect.left - rect.width / 2, clientY - rect.top - rect.height / 2)
    const z = Math.min(m.getMaxZoom(), Math.max(m.getMinZoom(), target))
    center = centerFor(center, zoom, z)
    zoom = z
    if (!raf) raf = requestAnimationFrame(draw)
  }

  const end = () => {
    window.clearTimeout(idle)
    idle = 0
    if (!center) return
    cancelAnimationFrame(raf)
    raf = 0
    // Settle on the nearest zoomSnap level, still anchored on the cursor.
    const snapped = m._limitZoom(zoom)
    const c = centerFor(center, zoom, snapped)
    center = null
    if (m.options.zoomAnimation) m._animateZoom(c, snapped, true, m.options.zoomSnap)
    else m._resetView(c, snapped)
  }

  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return // two-finger scroll or a mouse wheel: leave it to Leaflet
    // Keep Leaflet's wheel handler from also zooming, and the browser from zooming the page.
    e.preventDefault()
    e.stopImmediatePropagation()
    onUse()
    if (gesture) return // Safari reports the same pinch through gesture events
    const dy = e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY
    // Chrome sends deltaY = -100·ln(scale) per pinch step, so this tracks the fingers 1:1.
    const dz = -Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, dy)) / (100 * Math.LN2)
    zoomTo((center ? zoom : m.getZoom()) + dz, e.clientX, e.clientY)
    window.clearTimeout(idle)
    idle = window.setTimeout(end, PINCH_IDLE_MS)
  }

  const onGesture = (e: Event) => {
    const g = e as GestureEvt
    e.preventDefault()
    onUse()
    if (e.type === 'gesturestart') {
      gesture = true
      gestureBaseZoom = m._animatingZoom ? m._animateToZoom : m.getZoom()
    } else if (e.type === 'gesturechange') {
      if (g.scale > 0) zoomTo(gestureBaseZoom + Math.log2(g.scale), g.clientX, g.clientY)
    } else {
      gesture = false
      end()
    }
  }

  // Capture phase, so this runs before Leaflet's own wheel listener on the same container.
  container.addEventListener('wheel', onWheel, { capture: true, passive: false })
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) container.addEventListener(t, onGesture)

  return () => {
    container.removeEventListener('wheel', onWheel, { capture: true })
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) container.removeEventListener(t, onGesture)
    window.clearTimeout(idle)
    cancelAnimationFrame(raf)
    center = null
  }
}
