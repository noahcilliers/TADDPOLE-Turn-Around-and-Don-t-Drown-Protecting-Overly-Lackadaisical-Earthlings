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

function pinIcon(s: Sensor, selected: boolean) {
  const html = `<div class="ring">${statusSvg(s.current.status, 32)}</div>`
  return L.divIcon({
    className: `fr-pin ${s.current.status}${selected ? ' selected' : ''}`,
    html, iconSize: [44, 44], iconAnchor: [22, 22],
  })
}

function carIcon(heading: number) {
  return L.divIcon({
    className: 'fr-car',
    html: `<div class="halo"></div><div class="dot"><svg width="16" height="16" viewBox="0 0 24 24" style="transform:rotate(${heading}deg)"><path d="M12 3l7 17-7-4-7 4z" fill="#fff"/></svg></div>`,
    iconSize: [60, 60], iconAnchor: [30, 30],
  })
}

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

export default function FloodMap(p: Props) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layers = useRef<{ sensors: L.LayerGroup; routes: L.LayerGroup; top: L.LayerGroup } | null>(null)
  const carMarker = useRef<L.Marker | null>(null)
  const cb = useRef(p)
  cb.current = p

  // init once
  useEffect(() => {
    if (!el.current) return
    const m = L.map(el.current, { zoomControl: false, attributionControl: true, zoomSnap: 0.25, preferCanvas: false })
    m.setView([33.495, -111.997], 14)
    // Standard OSM tiles (no key), desaturated in CSS to the design's quiet grey basemap.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(m)
    L.control.zoom({ position: 'bottomleft' }).addTo(m)
    m.createPane('segments').style.zIndex = '420'
    m.createPane('route').style.zIndex = '430'
    layers.current = { routes: L.layerGroup().addTo(m), sensors: L.layerGroup().addTo(m), top: L.layerGroup().addTo(m) }
    m.on('click', (e: L.LeafletMouseEvent) => {
      if (cb.current.onMapClick) cb.current.onMapClick([e.latlng.lng, e.latlng.lat])
      else cb.current.onSelectSensor(null)
    })
    map.current = m
    const ro = new ResizeObserver(() => m.invalidateSize())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
      // Stop pan/zoom animations first: removing a map mid-zoom makes Leaflet's
      // transitionend handler touch a pane that no longer exists.
      m.stop(); m.off()
      ;(m as unknown as { _animatingZoom: boolean })._animatingZoom = false
      m.remove(); map.current = null
    }
  }, [])

  // sensors: segments + pins
  useEffect(() => {
    const g = layers.current?.sensors
    if (!g) return
    g.clearLayers()
    for (const s of p.sensors) {
      const st = s.current.status
      if (s.segment && s.segment.coordinates.length > 1) {
        const pts = s.segment.coordinates.map(ll)
        L.polyline(pts, { pane: 'segments', color: '#fff', weight: 16, opacity: 0.95, lineCap: 'round', interactive: false }).addTo(g)
        if (st === 'flooded') L.polyline(pts, { pane: 'segments', color: '#E5243B', weight: 22, opacity: 0.18, lineCap: 'round', interactive: false }).addTo(g)
        L.polyline(pts, {
          pane: 'segments', color: COLOR[st], weight: 10, lineCap: 'round', opacity: 1,
          dashArray: st === 'offline' ? '2 12' : undefined, interactive: false,
        }).addTo(g)
      }
      const mk = L.marker(ll(s.location.coordinates), {
        icon: pinIcon(s, s.id === p.selectedId), zIndexOffset: s.id === p.selectedId ? 1000 : st === 'flooded' ? 500 : 0,
        title: `${s.name}: ${st}`, keyboard: true, riseOnHover: true,
      })
      mk.on('click', (e) => { L.DomEvent.stopPropagation(e); cb.current.onSelectSensor(s.id) })
      mk.addTo(g)
    }
  }, [p.sensors, p.selectedId])

  // routes, destination, hazards
  useEffect(() => {
    const g = layers.current?.routes, top = layers.current?.top
    if (!g || !top) return
    g.clearLayers(); top.clearLayers()
    const order = { abandoned: 0, alt: 1, active: 2 }
    for (const r of [...p.routes].sort((a, b) => order[a.style] - order[b.style])) {
      if (r.coords.length < 2) continue
      const pts = r.coords.map(ll)
      if (r.style === 'active') {
        L.polyline(pts, { pane: 'route', color: '#fff', weight: 11, opacity: 1, interactive: false }).addTo(g)
        L.polyline(pts, { pane: 'route', color: '#2563EB', weight: 6, opacity: 1, interactive: false }).addTo(g)
      } else if (r.style === 'abandoned') {
        L.polyline(pts, { pane: 'route', color: '#94A3B8', weight: 5, dashArray: '1 10', lineCap: 'round', interactive: false }).addTo(g)
      } else {
        L.polyline(pts, { pane: 'route', color: '#E5243B', weight: 5, opacity: 0.55, dashArray: '8 8', interactive: false }).addTo(g)
      }
    }
    if (p.destination) L.marker(ll(p.destination), { icon: destIcon, interactive: false, zIndexOffset: 800 }).addTo(top)
    for (const h of p.hazards) {
      L.marker(ll(h.location.coordinates), { icon: hazardIcon, zIndexOffset: 1200, title: 'Stalled car reported' }).addTo(top)
    }
  }, [p.routes, p.destination, p.hazards])

  // car
  useEffect(() => {
    const m = map.current
    if (!m) return
    if (!p.car) { carMarker.current?.remove(); carMarker.current = null; return }
    if (!carMarker.current) carMarker.current = L.marker(ll(p.car.pos), { icon: carIcon(p.car.heading), interactive: false, zIndexOffset: 2000 }).addTo(m)
    else {
      carMarker.current.setLatLng(ll(p.car.pos))
      const svg = carMarker.current.getElement()?.querySelector('svg')
      if (svg) svg.style.transform = `rotate(${p.car.heading}deg)`
    }
    if (p.follow) {
      const pad = p.padding
      const size = m.getSize()
      // keep the car inside the visible area (outside overlays)
      const pt = m.latLngToContainerPoint(ll(p.car.pos))
      const inset = pad ?? { top: 0, right: 0, bottom: 0, left: 0 }
      if (pt.x < inset.left + 40 || pt.x > size.x - inset.right - 40 || pt.y < inset.top + 40 || pt.y > size.y - inset.bottom - 40) {
        m.panTo(ll(p.car.pos), { animate: true, duration: 0.6 })
      }
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
