import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Hazard, LngLat, Sensor, Status } from '../types'
import { statusSvg } from './pinSvg'

export interface MapRoute { coords: LngLat[]; style: 'active' | 'abandoned' | 'alt' }
export interface MapCar { pos: LngLat; heading: number }

interface Props {
  sensors: Sensor[]
  hazards: Hazard[]
  routes: MapRoute[]
  car: MapCar | null
  destination: LngLat | null
  selectedId: string | null
  onSelectSensor: (id: string | null) => void
  onMapClick?: (p: LngLat) => void
  /** Change this value to refit the view to `fitTo`. */
  fitKey?: string | number
  fitTo?: LngLat[]
  padding?: { top: number; right: number; bottom: number; left: number }
  follow?: boolean
}

const COLOR: Record<Status, string> = { clear: '#14A35A', caution: '#F2B300', flooded: '#E5243B', offline: '#8A93A0' }
const ll = (p: LngLat): L.LatLngExpression => [p[1], p[0]]
const lls = (c: LngLat[]) => c.map((p) => L.latLng(p[1], p[0]))
/** After the user drags/zooms, don't auto-follow the car for this long. */
const USER_HOLD_MS = 8000

function pinIcon(status: Status, selected: boolean) {
  return L.divIcon({
    className: `fr-pin ${status}${selected ? ' selected' : ''}`,
    html: `<div class="ring">${statusSvg(status, 32)}</div>`,
    iconSize: [44, 44], iconAnchor: [22, 22],
  })
}

const carIcon = L.divIcon({
  className: 'fr-car',
  html: `<div class="halo"></div><div class="dot"><svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 3l7 17-7-4-7 4z" fill="#fff"/></svg></div>`,
  iconSize: [60, 60], iconAnchor: [30, 30],
})

const destIcon = L.divIcon({
  className: 'fr-dest',
  html: `<svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 43s15-14 15-25A15 15 0 002 18c0 11 15 25 15 25z" fill="#0F172A" stroke="#fff" stroke-width="2.5"/><circle cx="17" cy="17" r="5.5" fill="#fff"/></svg>`,
  iconSize: [34, 44], iconAnchor: [17, 42],
})

const hazardIcon = L.divIcon({
  className: 'fr-hazard',
  html: `<div class="h"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16l1.6-5.2A2 2 0 018.5 9.4h7a2 2 0 011.9 1.4L19 16"/><rect x="3.5" y="15.5" width="17" height="4" rx="1.5"/></svg></div>`,
  iconSize: [38, 38], iconAnchor: [19, 19],
})

interface SensorLayer { casing: L.Polyline; glow: L.Polyline; line: L.Polyline; marker: L.Marker; key: string; seg: string; loc: string }
interface RouteLayers { casing: L.Polyline; active: L.Polyline; abandoned: L.Polyline; alt: L.Polyline }

/* Everything on the map is created once and then updated in place (setLatLngs / setIcon /
 * setStyle). Rebuilding layers on every live update is what made zooming and panning jittery. */
export default function FloodMap(p: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const sensorLayers = useRef(new Map<string, SensorLayer>())
  const routeLayers = useRef<RouteLayers | null>(null)
  const destMarker = useRef<L.Marker | null>(null)
  const hazardMarkers = useRef(new Map<string, L.Marker>())
  const carMarker = useRef<L.Marker | null>(null)
  const userAt = useRef(0)
  const panning = useRef(false)
  const cb = useRef(p)
  cb.current = p

  // init once
  useEffect(() => {
    if (!el.current) return
    const m = L.map(el.current, {
      zoomControl: false,
      // smooth, predictable zoom: quarter-level steps, gentler wheel, no wheel debounce lag
      zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 110, wheelDebounceTime: 20,
      inertia: true, inertiaDeceleration: 2200, easeLinearity: 0.25,
    })
    m.setView([33.495, -111.997], 14)
    // Standard OSM tiles (no key), desaturated in CSS to the design's quiet grey basemap.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, keepBuffer: 4, updateWhenZooming: false,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m)
    L.control.zoom({ position: 'bottomleft' }).addTo(m)
    m.createPane('segments').style.zIndex = '420'
    m.createPane('route').style.zIndex = '430'

    const line = (o: L.PolylineOptions) => L.polyline([], { interactive: false, pane: 'route', ...o }).addTo(m)
    routeLayers.current = {
      abandoned: line({ color: '#94A3B8', weight: 5, dashArray: '1 10', lineCap: 'round' }),
      alt: line({ color: '#E5243B', weight: 5, opacity: 0.55, dashArray: '8 8' }),
      casing: line({ color: '#fff', weight: 11 }),
      active: line({ color: '#2563EB', weight: 6 }),
    }

    m.on('click', (e: L.LeafletMouseEvent) => {
      if (cb.current.onMapClick) cb.current.onMapClick([e.latlng.lng, e.latlng.lat])
      else cb.current.onSelectSensor(null)
    })
    // Remember when the user last touched the map, so auto-follow doesn't fight them.
    const touched = () => { userAt.current = Date.now() }
    const c = el.current
    c.addEventListener('pointerdown', touched)
    c.addEventListener('wheel', touched, { passive: true })
    c.addEventListener('touchstart', touched, { passive: true })
    // The car glides between updates (CSS transition) but must snap during zoom.
    m.on('zoomstart', () => c.classList.add('fr-zooming'))
    m.on('zoomend', () => window.setTimeout(() => c.classList.remove('fr-zooming'), 50))
    m.on('movestart', () => { panning.current = true })
    m.on('moveend', () => { panning.current = false })

    map.current = m
    const ro = new ResizeObserver(() => m.invalidateSize({ pan: false }))
    ro.observe(c)
    const sensors = sensorLayers.current, hazards = hazardMarkers.current
    return () => {
      ro.disconnect()
      c.removeEventListener('pointerdown', touched)
      c.removeEventListener('wheel', touched)
      c.removeEventListener('touchstart', touched)
      // Stop pan/zoom animations first: removing a map mid-zoom makes Leaflet's
      // transitionend handler touch a pane that no longer exists.
      m.stop(); m.off()
      ;(m as unknown as { _animatingZoom: boolean })._animatingZoom = false
      m.remove(); map.current = null
      // these all belonged to the map we just removed
      carMarker.current = null; destMarker.current = null; routeLayers.current = null
      sensors.clear(); hazards.clear()
    }
  }, [])

  // sensors: segments + pins, diffed by id
  useEffect(() => {
    const m = map.current
    if (!m) return
    const seen = new Set<string>()
    for (const s of p.sensors) {
      seen.add(s.id)
      const st = s.current.status
      const selected = s.id === p.selectedId
      const key = `${st}|${selected}`
      const seg = s.segment && s.segment.coordinates.length > 1 ? s.segment.coordinates : []
      const segKey = JSON.stringify(seg)
      const locKey = s.location.coordinates.join(',')
      let layer = sensorLayers.current.get(s.id)
      if (!layer) {
        const opt = { pane: 'segments', interactive: false, lineCap: 'round' as const }
        const marker = L.marker(ll(s.location.coordinates), { icon: pinIcon(st, selected), title: `${s.name}: ${st}`, keyboard: true, riseOnHover: true })
        marker.on('click', (e) => { L.DomEvent.stopPropagation(e); cb.current.onSelectSensor(s.id) })
        layer = {
          casing: L.polyline(lls(seg), { ...opt, color: '#fff', weight: 16, opacity: 0.95 }).addTo(m),
          glow: L.polyline(lls(seg), { ...opt, color: '#E5243B', weight: 22, opacity: 0 }).addTo(m),
          line: L.polyline(lls(seg), { ...opt, color: COLOR[st], weight: 10 }).addTo(m),
          marker: marker.addTo(m),
          key: '', seg: segKey, loc: locKey,
        }
        sensorLayers.current.set(s.id, layer)
      }
      if (layer.seg !== segKey) {
        layer.casing.setLatLngs(lls(seg)); layer.glow.setLatLngs(lls(seg)); layer.line.setLatLngs(lls(seg)); layer.seg = segKey
      }
      if (layer.loc !== locKey) { layer.marker.setLatLng(ll(s.location.coordinates)); layer.loc = locKey }
      if (layer.key !== key) {
        layer.marker.setIcon(pinIcon(st, selected))
        layer.marker.setZIndexOffset(selected ? 1000 : st === 'flooded' ? 500 : 0)
        layer.marker.options.title = `${s.name}: ${st}`
        layer.line.setStyle({ color: COLOR[st], dashArray: st === 'offline' ? '2 12' : undefined })
        layer.glow.setStyle({ opacity: st === 'flooded' ? 0.18 : 0 })
        layer.key = key
      }
    }
    for (const [id, layer] of sensorLayers.current) {
      if (seen.has(id)) continue
      layer.casing.remove(); layer.glow.remove(); layer.line.remove(); layer.marker.remove()
      sensorLayers.current.delete(id)
    }
  }, [p.sensors, p.selectedId])

  // routes: same four polylines, new coordinates
  useEffect(() => {
    const r = routeLayers.current
    if (!r) return
    const get = (style: MapRoute['style']) => p.routes.find((x) => x.style === style)?.coords ?? []
    const active = lls(get('active'))
    r.casing.setLatLngs(active); r.active.setLatLngs(active)
    r.abandoned.setLatLngs(lls(get('abandoned')))
    r.alt.setLatLngs(lls(get('alt')))
  }, [p.routes])

  // destination
  useEffect(() => {
    const m = map.current
    if (!m) return
    if (!p.destination) { destMarker.current?.remove(); destMarker.current = null; return }
    if (!destMarker.current) destMarker.current = L.marker(ll(p.destination), { icon: destIcon, interactive: false, zIndexOffset: 800 }).addTo(m)
    else destMarker.current.setLatLng(ll(p.destination))
  }, [p.destination])

  // hazards, diffed by id
  useEffect(() => {
    const m = map.current
    if (!m) return
    const ids = new Set(p.hazards.map((h) => h.id))
    for (const [id, mk] of hazardMarkers.current) if (!ids.has(id)) { mk.remove(); hazardMarkers.current.delete(id) }
    for (const h of p.hazards) {
      if (!hazardMarkers.current.has(h.id)) {
        hazardMarkers.current.set(h.id, L.marker(ll(h.location.coordinates), { icon: hazardIcon, zIndexOffset: 1200, title: 'Stalled car reported' }).addTo(m))
      }
    }
  }, [p.hazards])

  // car
  useEffect(() => {
    const m = map.current
    if (!m) return
    if (!p.car) { carMarker.current?.remove(); carMarker.current = null; return }
    if (!carMarker.current) carMarker.current = L.marker(ll(p.car.pos), { icon: carIcon, interactive: false, zIndexOffset: 2000 }).addTo(m)
    else carMarker.current.setLatLng(ll(p.car.pos))
    const svg = carMarker.current.getElement()?.querySelector('svg')
    if (svg) svg.style.transform = `rotate(${p.car.heading}deg)`

    // Follow the car only when it's about to leave the view, and never while the user
    // is (or just was) moving the map themselves.
    if (!p.follow || panning.current || Date.now() - userAt.current < USER_HOLD_MS) return
    const size = m.getSize()
    const inset = p.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
    const pt = m.latLngToContainerPoint(ll(p.car.pos))
    const margin = 60
    if (pt.x < inset.left + margin || pt.x > size.x - inset.right - margin || pt.y < inset.top + margin || pt.y > size.y - inset.bottom - margin) {
      m.panTo(ll(p.car.pos), { animate: true, duration: 0.8, easeLinearity: 0.35 })
    }
  }, [p.car, p.follow, p.padding])

  // fit
  useEffect(() => {
    const m = map.current
    if (!m || !p.fitTo || p.fitTo.length === 0) return
    const b = L.latLngBounds(p.fitTo.map(ll))
    const pad = p.padding ?? { top: 40, right: 40, bottom: 40, left: 40 }
    m.fitBounds(b.pad(0.05), { paddingTopLeft: [pad.left, pad.top], paddingBottomRight: [pad.right, pad.bottom], maxZoom: 16, animate: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fitKey])

  return <div ref={el} className="map" role="application" aria-label="Map of flood sensors and routes" />
}
