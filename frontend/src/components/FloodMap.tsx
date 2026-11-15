import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Hazard, LngLat, Sensor, Status } from '../types'
import { statusSvg } from './pinSvg'
import { FROG_SVG_INNER } from './frogSvg'
import { enableTrackpadPinch } from './trackpadPinch'

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
  /** Radius (m) of the closed zone drawn around flooded sensors. */
  floodZoneM?: number
}

const COLOR: Record<Status, string> = { clear: '#14A35A', caution: '#F2B300', flooded: '#E5243B', offline: '#8A93A0' }
const ll = (p: LngLat): L.LatLngExpression => [p[1], p[0]]
const lls = (c: LngLat[]) => c.map((p) => L.latLng(p[1], p[0]))
/** Map centre that puts `pos` in the middle of the area the overlays leave visible. */
function followCenter(m: L.Map, pos: LngLat, z: number, pad?: Props['padding']): L.LatLng {
  const p = pad ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const off = L.point((p.right - p.left) / 2, (p.bottom - p.top) / 2)
  return m.unproject(m.project(ll(pos), z).add(off), z)
}
/** Heading changes smaller than this are route-line wobble, not a turn. */
const TURN_DEADBAND_DEG = 12

function pinIcon(status: Status, selected: boolean) {
  return L.divIcon({
    className: `fr-pin ${status}${selected ? ' selected' : ''}`,
    html: `<div class="ring">${statusSvg(status, 32)}</div>`,
    iconSize: [44, 44], iconAnchor: [22, 22],
  })
}

// TADDPOLE mascot. Drawn nose-up so the heading rotation applied to the <svg> points it along the route.
const carIcon = L.divIcon({
  className: 'fr-car',
  html: `<div class="halo"></div><svg class="frog" width="60" height="60" viewBox="0 0 60 60">${FROG_SVG_INNER}</svg>`,
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

interface SensorLayer { zone: L.Circle; casing: L.Polyline; glow: L.Polyline; line: L.Polyline; marker: L.Marker; key: string; seg: string; loc: string }
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
  const renderers = useRef<{ segments: L.Renderer; route: L.Renderer } | null>(null)
  /** Frog's on-screen rotation, unwrapped (may go past 360) so CSS never spins the long way. */
  const carRot = useRef<number | null>(null)
  const recenterBtn = useRef<HTMLButtonElement | null>(null)
  const recenter = useRef(() => {})
  const setFollow = useRef<(on: boolean) => void>(() => {})
  /** The view keeps the frog centred until the user drags the map; the frog button turns it back on. */
  const following = useRef(true)
  const pinchAt = useRef(0)
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
    // "Back to the driver": the mascot, sitting just above +/- (bottom corners stack upward,
    // so a control added after the zoom one lands on top of it).
    const Recenter = L.Control.extend({
      onAdd: () => {
        const b = L.DomUtil.create('button', 'fr-recenter leaflet-bar') as HTMLButtonElement
        b.type = 'button'
        b.title = 'Back to the driver'
        b.setAttribute('aria-label', 'Back to the driver')
        b.innerHTML = `<svg viewBox="8 0 44 60" width="30" height="34">${FROG_SVG_INNER}</svg>`
        L.DomEvent.disableClickPropagation(b)
        L.DomEvent.on(b, 'click', () => recenter.current())
        recenterBtn.current = b
        return b
      },
    })
    new Recenter({ position: 'bottomleft' }).addTo(m)
    m.createPane('segments').style.zIndex = '420'
    m.createPane('route').style.zIndex = '430'
    // One SVG renderer per pane with a generous padding: lines are clipped to the view plus
    // this margin, so a tight margin makes line ends get re-clipped mid-zoom (visible wobble).
    renderers.current = {
      segments: L.svg({ pane: 'segments', padding: 0.6 }),
      route: L.svg({ pane: 'route', padding: 0.6 }),
    }

    // smoothFactor 0: Leaflet otherwise re-simplifies lines per zoom level, so their shape shifts as you zoom
    const line = (o: L.PolylineOptions) => L.polyline([], { interactive: false, pane: 'route', renderer: renderers.current!.route, smoothFactor: 0, ...o }).addTo(m)
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
    const c = el.current
    // ----- follow mode -----
    // Dragging the map lets go of the frog. Zooming doesn't: while following, every kind of zoom
    // (wheel, trackpad pinch, +/-, double-click, touch pinch) happens around the frog, so it stays put.
    const carPoint = (): L.Point | null => {
      const car = cb.current.car
      return following.current && cb.current.follow && car ? m.latLngToContainerPoint(ll(car.pos)) : null
    }
    const setFollowing = (on: boolean) => {
      following.current = on
      m.options.touchZoom = on ? 'center' : true
      m.options.doubleClickZoom = on ? 'center' : true
      recenterBtn.current?.classList.toggle('following', on)
    }
    setFollow.current = setFollowing
    setFollowing(true)
    m.on('dragstart', () => setFollowing(false))
    // Leaflet's wheel zoom anchors on the last mouse position; swap in the frog's position.
    const swz = m.scrollWheelZoom as unknown as { _onWheelScroll: (e: Event) => void; _lastMousePos: L.Point }
    m.scrollWheelZoom.disable()
    const wheel = swz._onWheelScroll
    swz._onWheelScroll = function (this: typeof swz, e: Event) {
      wheel.call(this, e)
      const a = carPoint()
      if (a) this._lastMousePos = a
    }
    m.scrollWheelZoom.enable()
    const zoomIn = m.zoomIn.bind(m), zoomOut = m.zoomOut.bind(m)
    const step = (d?: number) => d ?? m.options.zoomDelta ?? 1
    m.zoomIn = (d, o) => { const a = carPoint(); return a ? m.setZoomAround(a, m.getZoom() + step(d), o) : zoomIn(d, o) }
    m.zoomOut = (d, o) => { const a = carPoint(); return a ? m.setZoomAround(a, m.getZoom() - step(d), o) : zoomOut(d, o) }
    // Laptop trackpad pinch: follow the fingers continuously, like touch pinch on phones.
    const disablePinch = enableTrackpadPinch(m, () => { pinchAt.current = Date.now() }, carPoint)
    // After any zoom, settle the frog back into its spot (the padding offset scales with zoom).
    m.on('zoomend', () => {
      const car = cb.current.car
      if (following.current && cb.current.follow && car) m.panTo(followCenter(m, car.pos, m.getZoom(), cb.current.padding), { animate: true, duration: 0.25, easeLinearity: 1, noMoveStart: true })
    })
    // The car glides between updates (CSS transition) but must snap during zoom.
    m.on('zoomstart', () => c.classList.add('fr-zooming'))
    m.on('zoomend', () => window.setTimeout(() => c.classList.remove('fr-zooming'), 50))

    map.current = m
    const ro = new ResizeObserver(() => m.invalidateSize({ pan: false }))
    ro.observe(c)
    const sensors = sensorLayers.current, hazards = hazardMarkers.current
    return () => {
      ro.disconnect()
      disablePinch()
      // Stop pan/zoom animations first: removing a map mid-zoom makes Leaflet's
      // transitionend handler touch a pane that no longer exists.
      m.stop(); m.off()
      ;(m as unknown as { _animatingZoom: boolean })._animatingZoom = false
      m.remove(); map.current = null
      // these all belonged to the map we just removed
      carMarker.current = null; destMarker.current = null; routeLayers.current = null; renderers.current = null
      recenterBtn.current = null
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
        const opt = { pane: 'segments', interactive: false, lineCap: 'round' as const, renderer: renderers.current?.segments, smoothFactor: 0 }
        const marker = L.marker(ll(s.location.coordinates), { icon: pinIcon(st, selected), title: `${s.name}: ${st}`, keyboard: true, riseOnHover: true })
        marker.on('click', (e) => { L.DomEvent.stopPropagation(e); cb.current.onSelectSensor(s.id) })
        layer = {
          // the closed zone around a flooded sensor: what the reroute goes around
          zone: L.circle(ll(s.location.coordinates), { radius: p.floodZoneM ?? 300, pane: 'segments', renderer: renderers.current?.segments, interactive: false,
            color: '#E5243B', weight: 1.5, dashArray: '4 6', opacity: 0, fillColor: '#E5243B', fillOpacity: 0 }).addTo(m),
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
      if (layer.loc !== locKey) { layer.marker.setLatLng(ll(s.location.coordinates)); layer.zone.setLatLng(ll(s.location.coordinates)); layer.loc = locKey }
      if (p.floodZoneM && layer.zone.getRadius() !== p.floodZoneM) layer.zone.setRadius(p.floodZoneM)
      if (layer.key !== key) {
        layer.marker.setIcon(pinIcon(st, selected))
        layer.marker.setZIndexOffset(selected ? 1000 : st === 'flooded' ? 500 : 0)
        layer.marker.options.title = `${s.name}: ${st}`
        layer.line.setStyle({ color: COLOR[st], dashArray: st === 'offline' ? '2 12' : undefined })
        layer.glow.setStyle({ opacity: st === 'flooded' ? 0.18 : 0 })
        layer.zone.setStyle(st === 'flooded' ? { opacity: 0.55, fillOpacity: 0.08 } : { opacity: 0, fillOpacity: 0 })
        layer.key = key
      }
    }
    for (const [id, layer] of sensorLayers.current) {
      if (seen.has(id)) continue
      layer.zone.remove(); layer.casing.remove(); layer.glow.remove(); layer.line.remove(); layer.marker.remove()
      sensorLayers.current.delete(id)
    }
  }, [p.sensors, p.selectedId, p.floodZoneM])

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

  // Mascot button: fly back to the car (keeping the overlay padding in mind) and resume following.
  recenter.current = () => {
    const m = map.current, car = cb.current.car
    if (!m || !car) return
    const z = Math.max(m.getZoom(), 15)
    setFollow.current(true)
    m.setView(followCenter(m, car.pos, z, cb.current.padding), z, { animate: true, duration: 0.6 })
  }
  useEffect(() => {
    recenterBtn.current?.classList.toggle('off', !p.car)
  }, [p.car])

  // car
  useEffect(() => {
    const m = map.current
    if (!m) return
    if (!p.car) { carMarker.current?.remove(); carMarker.current = null; carRot.current = null; return }
    if (!carMarker.current) carMarker.current = L.marker(ll(p.car.pos), { icon: carIcon, interactive: false, zIndexOffset: 2000 }).addTo(m)
    else carMarker.current.setLatLng(ll(p.car.pos))
    // Turn the frog the short way round (359° → 1° is +2°, not a full spin), and ignore
    // small wobbles in the route line so it only turns on real turns.
    const h = p.car.heading
    if (Number.isFinite(h)) {
      const prev = carRot.current
      const delta = prev === null ? h : ((h - prev) % 360 + 540) % 360 - 180
      if (prev === null || Math.abs(delta) >= TURN_DEADBAND_DEG) carRot.current = prev === null ? h : prev + delta
    }
    const svg = carMarker.current.getElement()?.querySelector('svg')
    if (svg && carRot.current !== null) svg.style.transform = `rotate(${carRot.current}deg)`

    // Follow: glide the view along with the frog, at the same pace as the frog's own glide
    // (.fr-car transition), so it stays steady in its spot. Never mid-zoom or mid-pinch.
    if (!p.follow || !following.current) return
    const mm = m as unknown as { _animatingZoom: boolean; touchZoom: { _zooming?: boolean } }
    if (mm._animatingZoom || mm.touchZoom?._zooming || Date.now() - pinchAt.current < 250) return
    const target = followCenter(m, p.car.pos, m.getZoom(), p.padding)
    const size = m.getSize()
    const off = m.latLngToContainerPoint(target).distanceTo(size.divideBy(2))
    if (off < 0.5) return
    if (off > Math.max(size.x, size.y)) m.setView(target, m.getZoom(), { animate: false })   // jumped (new trip): no long slide
    else m.panTo(target, { animate: true, duration: 0.25, easeLinearity: 1, noMoveStart: true })
  }, [p.car, p.follow, p.padding])

  // fit
  useEffect(() => {
    const m = map.current
    if (!m || !p.fitTo || p.fitTo.length === 0) return
    if (p.follow && following.current && p.car) return   // following the frog: it decides the view
    const b = L.latLngBounds(p.fitTo.map(ll))
    const pad = p.padding ?? { top: 40, right: 40, bottom: 40, left: 40 }
    m.fitBounds(b.pad(0.05), { paddingTopLeft: [pad.left, pad.top], paddingBottomRight: [pad.right, pad.bottom], maxZoom: 16, animate: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fitKey])

  return <div ref={el} className="map" role="application" aria-label="Map of flood sensors and routes" />
}
