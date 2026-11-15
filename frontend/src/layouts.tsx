import { useEffect, useMemo, useState } from 'react'
import FloodMap, { type MapRoute } from './components/FloodMap'
import { AlertFeed, SensorList } from './components/Lists'
import { AlertOverlay, BlockedBar, ConnBanner, DemoPanel, Legend, LivePill, ToastView } from './components/Overlays'
import { SettingsPage } from './components/Screens'
import SensorPanel from './components/SensorPanel'
import { Brand, Icon } from './components/icons'
import { useDrive } from './drive'
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
// The judges' view: opens straight on Drive, nothing on screen but the map, the car and
// the alerts that matter. Mode switching and demo controls live on the presenter's laptop.
type PhoneTab = 'sensors' | 'drive' | 'alerts'

export function Phone() {
  const [tab, setTab] = useState<PhoneTab>('drive')
  const [detail, setDetail] = useState<string | null>(null)     // sensor id shown full-screen
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { sensors, hazards, routes, fitTo, drive } = useMapData(true)

  const go = (t: PhoneTab) => { setTab(t); setDetail(null); setSettingsOpen(false) }

  return (
    <div className="phone">
      <FloodMap
        sensors={sensors} hazards={hazards} routes={routes} car={drive.car}
        destination={drive.mode === 'nav' ? drive.destination?.lnglat ?? null : null}
        selectedId={detail} onSelectSensor={(id) => setDetail(id)}
        fitKey={`${sensors.length > 0}|${drive.active?.id ?? ''}`} fitTo={fitTo}
        padding={{ top: 90, right: 20, bottom: 110, left: 20 }}
        follow={tab === 'drive' && !detail}
      />

      {/* Drive: only alerts and short notices on top of the map */}
      {tab === 'drive' && !detail && (
        drive.alert ? (
          <div className="alert-top"><AlertOverlay alert={drive.alert} /></div>
        ) : (
          <div className="top">
            <div className="row" style={{ justifyContent: 'space-between' }}><Brand /><LivePill /></div>
            <ConnBanner />
            <ToastView />
            <BlockedBar />
          </div>
        )
      )}

      {tab === 'sensors' && !detail && (
        <div className="page">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <LivePill />
            <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings"><Icon.Settings size={19} /></button>
          </div>
          <SensorList title onSelect={setDetail} />
        </div>
      )}

      {tab === 'alerts' && !detail && (
        <div className="page">
          <div className="row" style={{ justifyContent: 'flex-end' }}><LivePill /></div>
          <AlertFeed title onSelect={setDetail} />
        </div>
      )}

      {detail && (
        <div className="page" role="dialog" aria-label="Sensor details">
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="icon-btn" onClick={() => setDetail(null)} aria-label="Close"><Icon.Close size={20} /></button>
          </div>
          <SensorPanel id={detail} />
        </div>
      )}

      {settingsOpen && (
        <div className="page" role="dialog" aria-label="Settings" style={{ zIndex: 560 }}>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="Close"><Icon.Close size={20} /></button>
          </div>
          <SettingsPage />
        </div>
      )}

      <div className="bottom">
        <nav className="tabbar" aria-label="Main">
          <button aria-pressed={tab === 'sensors'} onClick={() => go('sensors')}><Icon.Broadcast size={22} />Sensors</button>
          <button aria-pressed={tab === 'drive'} onClick={() => go('drive')}><Icon.Wheel size={22} />Drive</button>
          <button aria-pressed={tab === 'alerts'} onClick={() => go('alerts')}><Icon.Bell size={22} />Alerts</button>
        </nav>
      </div>
    </div>
  )
}
