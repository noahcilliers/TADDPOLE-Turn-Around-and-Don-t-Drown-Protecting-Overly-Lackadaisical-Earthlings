import { useEffect, useMemo, useState } from 'react'
import FloodMap, { type MapRoute } from './components/FloodMap'
import { AlertFeed, SensorList } from './components/Lists'
import { AlertOverlay, BlockedBar, ConnBanner, DemoPanel, Legend, LivePill, NavBanner, RouteCard, StatusChips, ToastView } from './components/Overlays'
import { DestinationSearch, DriveSheet, SettingsPage, Summary } from './components/Screens'
import SensorPanel from './components/SensorPanel'
import { Brand, Icon } from './components/icons'
import { useDrive } from './drive'
import { ago, depthText, STATUS_LABEL, trend } from './format'
import { useStore } from './store'
import type { LngLat } from './types'

function useMapData(showRoute: boolean) {
  const sensorsMap = useStore((s) => s.sensors)
  const hazardsMap = useStore((s) => s.hazards)
  const drive = useDrive()
  const sensors = useMemo(() => Object.values(sensorsMap), [sensorsMap])
  const hazards = useMemo(() => Object.values(hazardsMap), [hazardsMap])
  const routes: MapRoute[] = useMemo(() => {
    if (!showRoute) return []
    const out: MapRoute[] = []
    if (drive.abandoned) out.push({ coords: drive.abandoned, style: 'abandoned' })
    if (drive.remaining) out.push({ coords: drive.remaining, style: 'active' })
    return out
  }, [showRoute, drive.abandoned, drive.remaining])
  // initial fit: every sensor + the trip
  const fitTo = useMemo<LngLat[]>(() => {
    const pts = sensors.map((s) => s.location.coordinates)
    if (drive.active) pts.push(...drive.active.geometry.coordinates)
    return pts
  }, [sensors.length, drive.active?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  return { sensors, hazards, routes, fitTo, drive }
}


// ---- resizable side panel (width remembered per device) ----
const SIDE_KEY = 'floodroute.sideWidth'
const SIDE_MIN = 320
const sideMax = () => Math.max(SIDE_MIN, Math.round(window.innerWidth * 0.6))
const clampSide = (w: number) => Math.min(sideMax(), Math.max(SIDE_MIN, Math.round(w)))

function useSideWidth() {
  const [w, setW] = useState<number>(() => {
    try { const v = Number(localStorage.getItem(SIDE_KEY)); if (v) return clampSide(v) } catch { /* private mode */ }
    return window.innerWidth <= 1280 ? 420 : 480
  })
  const save = (v: number) => { const c = clampSide(v); setW(c); try { localStorage.setItem(SIDE_KEY, String(c)) } catch { /* ignore */ } }
  useEffect(() => {
    const on = () => setW((cur) => clampSide(cur))
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return [w, save] as const
}

function Divider({ width, onChange }: { width: number; onChange: (w: number) => void }) {
  const [dragging, setDragging] = useState(false)
  const start = (e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragging(true)
  }
  return (
    <div
      className={`divider${dragging ? ' dragging' : ''}`}
      role="separator" aria-orientation="vertical" aria-label="Resize panel"
      aria-valuenow={width} aria-valuemin={SIDE_MIN} aria-valuemax={sideMax()} tabIndex={0}
      style={{ left: width }}
      onPointerDown={start}
      onPointerMove={(e) => { if (dragging) onChange(e.clientX) }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => onChange(480)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 20
        if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(width - step) }
        if (e.key === 'ArrowRight') { e.preventDefault(); onChange(width + step) }
      }}
      title="Drag to resize · double-click to reset"
    />
  )
}

// =============================== STAGE ===============================
type SideTab = 'sensor' | 'all' | 'alerts'

export function Stage() {
  const config = useStore((s) => s.config)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<SideTab>('sensor')
  const { sensors, hazards, routes, fitTo, drive } = useMapData(true)
  const sel = selected ?? config?.demo.sensor_id ?? sensors[0]?.id ?? null
  const select = (id: string | null) => { setSelected(id); if (id) setTab('sensor') }
  const [sideW, setSideW] = useSideWidth()

  return (
    <div className="stage" style={{ gridTemplateColumns: `${sideW}px 1fr` }}>
      <Divider width={sideW} onChange={setSideW} />
      <aside className="stage-side" aria-label="Details">
        <div className="side-head">
          <Brand />
          <ConnBanner />
        </div>
        <div className="tabs">
          <div className="seg" role="tablist">
            <button role="tab" aria-pressed={tab === 'sensor'} aria-selected={tab === 'sensor'} onClick={() => setTab('sensor')}>Sensor</button>
            <button role="tab" aria-pressed={tab === 'all'} aria-selected={tab === 'all'} onClick={() => setTab('all')}>All sensors</button>
            <button role="tab" aria-pressed={tab === 'alerts'} aria-selected={tab === 'alerts'} onClick={() => setTab('alerts')}>Alerts</button>
          </div>
        </div>
        <div className="scroll">
          {tab === 'sensor' && (sel ? <SensorPanel id={sel} onClose={() => setTab('all')} /> : <div className="empty">Tap a sensor on the map.</div>)}
          {tab === 'all' && <SensorList onSelect={select} selectedId={sel} />}
          {tab === 'alerts' && <AlertFeed onSelect={select} />}
        </div>
      </aside>
      <div className="stage-map">
        <FloodMap
          sensors={sensors} hazards={hazards} routes={routes} car={drive.car}
          destination={drive.mode === 'nav' ? drive.destination?.lnglat ?? null : null}
          selectedId={sel} onSelectSensor={select}
          fitKey={`${sensors.length > 0}|${drive.mode}`} fitTo={fitTo}
          padding={{ top: 80, right: 380, bottom: 40, left: 40 }} follow
        />
        <div className="overlay tr"><Legend /></div>
        <div className="overlay br"><DemoPanel variant="stage" /></div>
        {drive.alert
          ? <div className="overlay alert-slot"><AlertOverlay alert={drive.alert} /></div>
          : (drive.blocked || drive.toast) && (
            <div className="overlay alert-slot" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <BlockedBar />
              <ToastView />
            </div>
          )}
      </div>
    </div>
  )
}

// =============================== PHONE ===============================
type PhoneTab = 'map' | 'drive' | 'alerts'
type Page = null | 'sensors' | 'settings' | 'analytics'

export function Phone() {
  const [tab, setTab] = useState<PhoneTab>('map')
  const [page, setPage] = useState<Page>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const units = useStore((s) => s.settings.units)
  const sensor = useStore((s) => (selected ? s.sensors[selected] : undefined))
  const showRoute = tab === 'drive' || (tab === 'map' && !!selected === false)
  const { sensors, hazards, routes, fitTo, drive } = useMapData(showRoute)

  const select = (id: string | null) => { setSelected(id); if (id) { setTab('map'); setPage(null) } }
  const onMapClick = picking ? (p: LngLat) => { drive.setDestination({ lnglat: p, name: 'Dropped pin' }); drive.setMode('nav'); setPicking(false); setTab('drive') } : undefined

  return (
    <div className="phone">
      <FloodMap
        sensors={sensors} hazards={hazards} routes={routes} car={tab === 'drive' || drive.demoActive ? drive.car : null}
        destination={drive.mode === 'nav' && showRoute ? drive.destination?.lnglat ?? null : null}
        selectedId={selected} onSelectSensor={select} onMapClick={onMapClick}
        fitKey={`${sensors.length > 0}|${tab}|${drive.active?.id ?? ''}`} fitTo={fitTo}
        padding={{ top: tab === 'drive' ? 150 : 200, right: 20, bottom: tab === 'drive' ? 300 : 120, left: 20 }}
        follow={tab === 'drive'}
      />

      {/* top */}
      {drive.alert && tab !== 'alerts' ? (
        <div className="alert-top"><AlertOverlay alert={drive.alert} /></div>
      ) : (
        <div className="top">
          {tab === 'map' && (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <Brand />
                <div className="row"><LivePill />
                  <button className="pill" style={{ width: 40, padding: 0, justifyContent: 'center' }} onClick={() => setPage('sensors')} aria-label="All sensors"><Icon.Broadcast size={19} /></button>
                  <button className="pill" style={{ width: 40, padding: 0, justifyContent: 'center' }} onClick={() => setPage('settings')} aria-label="Settings"><Icon.Settings size={19} /></button>
                </div>
              </div>
              <DestinationSearch onPicked={(p) => { drive.setDestination(p); drive.setMode('nav'); setTab('drive') }} onPickOnMap={() => setPicking(true)} />
              <StatusChips />
              {picking && <div className="pill" style={{ alignSelf: 'center' }}>Tap the map to set your destination <button onClick={() => setPicking(false)} aria-label="Cancel"><Icon.Close size={16} /></button></div>}
              <ConnBanner />
            </>
          )}
          {tab === 'drive' && (
            drive.toast ? <ToastView /> : drive.mode === 'nav' && drive.active && drive.demoActive ? <NavBanner /> : <RouteCard />
          )}
          {tab === 'drive' && <BlockedBar />}
          {tab === 'map' && drive.toast?.tone === 'red' && <ToastView />}
        </div>
      )}

      {/* bottom */}
      <div className="bottom">
        {tab === 'map' && sensor && !page && (
          <div className="sheet">
            <div className="sp-head">
              <div className="grow">
                <div className={`sp-status st-${sensor.current.status}`}>{STATUS_LABEL[sensor.current.status]} · Updated {ago(sensor.current.last_reading_at)}</div>
                <div className="sp-name">{sensor.name}</div>
              </div>
              <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Close"><Icon.Close size={20} /></button>
            </div>
            <div className="depth" style={{ margin: '10px 0 14px' }}>
              <div><span className="depth-big" style={{ fontSize: 52 }}>{depthText(sensor.current.depth_cm, units).big}</span><span className="depth-unit">{depthText(sensor.current.depth_cm, units).unit}</span>
                <div className="depth-small">{depthText(sensor.current.depth_cm, units).small}</div></div>
              <span style={{ fontWeight: 700 }}>{sensor.current.status === 'offline' ? 'No data' : trend(sensor.current.rate_cm_per_min).label}</span>
            </div>
            <button className="btn btn-blue" style={{ width: '100%' }} onClick={() => setPage('analytics')}><Icon.Clock size={20} />Analytics · past hours</button>
          </div>
        )}
        {tab === 'drive' && !drive.arrived && <DriveSheet />}
        {tab === 'drive' && drive.arrived && <div className="sheet tall"><Summary trip={drive.arrived} onDone={() => { drive.clearArrived(); setTab('map') }} /></div>}
        <nav className="tabbar" aria-label="Main">
          <button aria-pressed={tab === 'map' && !page} onClick={() => { setTab('map'); setPage(null) }}><Icon.Map size={22} />Map</button>
          <button aria-pressed={tab === 'drive'} onClick={() => { setTab('drive'); setPage(null); setSelected(null) }}><Icon.Wheel size={22} />Drive</button>
          <button aria-pressed={tab === 'alerts'} onClick={() => { setTab('alerts'); setPage(null) }}><Icon.Bell size={22} />Alerts</button>
        </nav>
      </div>

      {tab === 'alerts' && <div className="page"><div className="row" style={{ justifyContent: 'space-between' }}><span /><LivePill /></div><AlertFeed title onSelect={select} /></div>}
      {page && (
        <div className="page" role="dialog" aria-label={page}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            {page === 'analytics' ? <span /> : <LivePill />}
            <button className="icon-btn" onClick={() => setPage(null)} aria-label="Close"><Icon.Close size={20} /></button>
          </div>
          {page === 'sensors' && <SensorList title onSelect={(id) => select(id)} />}
          {page === 'settings' && <SettingsPage />}
          {page === 'analytics' && selected && <div style={{ marginTop: 8 }}><SensorPanel id={selected} /></div>}
        </div>
      )}
    </div>
  )
}
