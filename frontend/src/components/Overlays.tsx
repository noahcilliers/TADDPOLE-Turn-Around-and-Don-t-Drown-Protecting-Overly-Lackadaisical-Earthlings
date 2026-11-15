import { useState } from 'react'
import { api, ApiError, getDemoKey, setDemoKey } from '../api'
import { useDrive } from '../drive'
import { ago, clock, fmtDuration, fmtMiles, STATUS_LABEL } from '../format'
import { reconnectNow, setDemo, useStore } from '../store'
import type { Status } from '../types'
import { useNow } from './SensorPanel'
import { Icon, StatusIcon } from './icons'

export function LivePill() {
  const conn = useStore((s) => s.conn)
  const last = useStore((s) => s.lastMsgAt)
  const now = useNow(1000)
  const secs = last ? Math.max(0, Math.round((now - last) / 1000)) : null
  if (conn !== 'live') {
    return <div className="pill" role="status"><span className="live-dot warn" />{conn === 'connecting' ? 'Connecting…' : 'Reconnecting'}</div>
  }
  return <div className="pill" role="status" aria-live="off"><span className="live-dot" />Live <span className="muted" style={{ fontWeight: 500 }}>{secs ?? 0} s ago</span></div>
}

export function StatusChips() {
  const sensors = useStore((s) => s.sensors)
  const counts: Record<Status, number> = { flooded: 0, caution: 0, clear: 0, offline: 0 }
  Object.values(sensors).forEach((s) => counts[s.current.status]++)
  const label: Record<Status, string> = { flooded: 'flooded', caution: 'rising', clear: 'clear', offline: 'offline' }
  return (
    <div className="chips" aria-label="Sensor status counts">
      {(['flooded', 'caution', 'clear', 'offline'] as Status[]).map((st) => (
        <span key={st} className={`pill chip st-${st}`}><StatusIcon status={st} size={16} />{counts[st]} {label[st]}</span>
      ))}
    </div>
  )
}

export function Legend() {
  return (
    <div className="pill legend" aria-label="Legend">
      {(['clear', 'caution', 'flooded', 'offline'] as Status[]).map((st) => (
        <span key={st} className="row" style={{ gap: 6 }}><StatusIcon status={st} size={17} />{STATUS_LABEL[st]}</span>
      ))}
    </div>
  )
}

/** Every notice uses this one bar shape (same height, padding and type), in its own colour:
 *  red for flooding / a stalled car, yellow for rising water, white for everything else. */
function Bar({ tone, icon, title, detail, children }: {
  tone: 'red' | 'yellow' | 'white'; icon: React.ReactNode; title: string; detail: string; children?: React.ReactNode
}) {
  return (
    <div className={`notice-bar ${tone}`} role={tone === 'white' ? 'status' : 'alert'} aria-live={tone === 'white' ? 'polite' : 'assertive'}>
      <span className="nb-ic">{icon}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="t ellipsis">{title}</div>
        <div className="d ellipsis">{detail}</div>
      </div>
      {children}
    </div>
  )
}

/** The flood / rising-water notice: stays put until the driver taps Reroute or ×. */
export function NoticeBar() {
  const drive = useDrive()
  const n = drive.notice
  if (!n) return null
  return (
    <Bar tone={n.tone} icon={<StatusIcon status={n.tone === 'yellow' ? 'caution' : 'flooded'} size={26} />} title={n.title} detail={n.detail}>
      <button className="btn btn-sm nb-go" onClick={drive.rerouteNow} disabled={drive.rerouting}>
        <Icon.Reroute size={18} />{drive.rerouting ? 'Rerouting…' : 'Reroute'}
      </button>
      {n.dismissible && <button className="nb-x" onClick={drive.dismissAlert} disabled={drive.rerouting} aria-label="Dismiss"><Icon.Close size={18} /></button>}
    </Bar>
  )
}

export function ToastView() {
  const { toast } = useDrive()
  if (!toast) return null
  const icon = toast.tone === 'green' ? <Icon.Flag size={16} /> : toast.tone === 'red' ? <Icon.Close size={16} /> : <Icon.Shield size={16} />
  return <Bar tone="white" icon={<span className={`nb-dot ${toast.tone}`}>{icon}</span>} title={toast.title} detail={toast.detail} />
}

export function RouteCard() {
  const drive = useDrive()
  const sensors = useStore((s) => s.sensors)
  const r = drive.active
  if (!r || !drive.destination) return null
  const remaining = drive.remaining ? Math.max(0, r.distance_m - drive.traveled_m) : r.distance_m
  // live statuses of the sensors this route crosses (the route object is a snapshot)
  const live = r.crosses.map((c) => sensors[c.sensor_id]?.current.status ?? c.status)
  const bad = live.find((st) => st === 'flooded' || st === 'offline')
  const rising = live.includes('caution')
  const safe = r.safe && !bad
  const label = !safe ? `Route · crosses ${bad ? STATUS_LABEL[bad].toLowerCase() : 'a hazard'} sensor`
    : r.kind === 'safer' ? `Safer route · +${Math.max(1, Math.round((r.delta_vs_fastest_s ?? 0) / 60))} min`
    : rising ? 'Route · water rising ahead' : r.crosses.length ? 'Route · all sensors clear' : 'Route · no sensors on route'
  const tone = !safe ? 'st-flooded' : rising ? 'st-caution' : 'st-clear'
  return (
    <div className="card route-card">
      <div className="ic" style={!safe ? { background: 'var(--red-soft)', color: 'var(--red)' } : undefined}><Icon.Broadcast size={24} /></div>
      <div className="grow">
        <div className={`k ${tone}`}>{label}</div>
        <div className="d ellipsis">To {drive.destination.name}</div>
      </div>
      <div className="n">{fmtMiles(remaining)} mi</div>
    </div>
  )
}

export function NavBanner() {
  const drive = useDrive()
  const r = drive.active
  if (!r || !r.steps.length) return null
  // current step = first whose cumulative distance exceeds traveled
  let acc = 0, idx = 0
  for (let i = 0; i < r.steps.length; i++) { acc += r.steps[i].distance_m; if (acc > drive.traveled_m) { idx = i; break } idx = i }
  const next = r.steps[Math.min(idx + 1, r.steps.length - 1)]
  const toNext = Math.max(0, acc - drive.traveled_m)
  const isLast = idx >= r.steps.length - 1
  return (
    <div className="nav-banner" role="status">
      <Icon.Turn size={30} />
      <div className="grow">
        <div className="n">{fmtMiles(toNext)} mi</div>
        <div className="i ellipsis">{isLast ? `Arrive at ${drive.destination?.name ?? 'destination'}` : next.instruction}</div>
      </div>
    </div>
  )
}

export function ConnBanner() {
  const conn = useStore((s) => s.conn)
  const last = useStore((s) => s.lastMsgAt)
  const sensors = useStore((s) => s.sensors)
  if (conn === 'live') return null
  const flooded = Object.values(sensors).filter((s) => s.current.status === 'flooded')
  return (
    <div className="card conn-card" role="alert">
      <div className="ic"><Icon.Wifi size={22} /></div>
      <div className="grow">
        <div style={{ fontWeight: 800, fontSize: 17 }}>{conn === 'connecting' && !last ? 'Connecting to live data…' : 'No live data'}</div>
        <div className="muted" style={{ fontWeight: 600, fontSize: 14, marginTop: 2 }}>
          {last ? `Last update ${ago(new Date(last).toISOString())}. ` : ''}Readings may be out of date; don't rely on them during a storm.
        </div>
        {flooded.length > 0 && <div style={{ fontWeight: 700, fontSize: 14, marginTop: 8 }}>Last known: <span className="st-flooded">{flooded.map((s) => `${s.name} flooded (${Math.round(s.current.depth_cm ?? 0)} cm)`).join(', ')}</span>. Keep avoiding it.</div>}
        <button className="btn btn-blue btn-sm" style={{ marginTop: 10 }} onClick={reconnectNow}><Icon.Reset size={17} />Try again</button>
      </div>
    </div>
  )
}

// ---------- demo controls ----------
function useDemoActions() {
  const [err, setErr] = useState<string | null>(null)
  const run = async (fn: () => Promise<import('../types').DemoSession>) => {
    try { setDemo(await fn()); setErr(null) }
    catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        const k = window.prompt('Demo key (ADMIN_TOKEN) to control the demo:', getDemoKey())
        if (k) { setDemoKey(k); try { setDemo(await fn()); setErr(null); return } catch (e2) { setErr(e2 instanceof Error ? e2.message : 'failed') } }
        else setErr('Demo key required')
      } else setErr(e instanceof Error ? e.message : 'Demo request failed')
    }
  }
  return { run, err }
}

export function DemoPanel({ variant }: { variant: 'stage' | 'phone' }) {
  const demo = useStore((s) => s.demo)
  const config = useStore((s) => s.config)
  const sensor = useStore((s) => (config ? s.sensors[config.demo.sensor_id] : undefined))
  const drive = useDrive()
  const { run, err } = useDemoActions()
  const [open, setOpen] = useState(true)
  if (!demo) return null
  const playing = demo.state === 'playing'
  const label = demo.state === 'idle' && demo.demo_s === 0 ? 'Play' : playing ? 'Pause' : 'Resume'
  const toggle = () => run(() => (playing ? api.demo.pause() : api.demo.start('nav', demo.speed)))
  // Both sources feed the same live sensor (config.demo.sensor_id): "Automatic" writes the
  // scripted depth curve as that sensor's readings, "Live" uses what the device itself reports.
  const setAuto = (auto: boolean) => { if (auto !== demo.scripted) void run(() => api.demo.scripted(auto)) }
  const liveDown = !demo.scripted && sensor?.current.status === 'offline'
  // demo clock shown as Phoenix time, 1 demo s = 10 real s (handoff), starting 6:40 PM
  const demoClock = clock(new Date(Date.parse('2026-08-15T01:40:00Z') + drive.demoS * 10_000))

  if (variant === 'phone') {
    return (
      <div className="demo-row" aria-label="Demo controls">
        <span className="tag-demo">DEMO</span>
        <button className="btn btn-dark btn-sm grow" style={{ height: 46 }} onClick={toggle}>{playing ? <Icon.Pause size={18} /> : <Icon.Play size={18} />}{label}</button>
        <button className="btn btn-ghost btn-sm sq" onClick={() => run(() => api.demo.speed(demo.speed >= 4 ? 1 : demo.speed * 2))} aria-label={`Speed ${demo.speed}×, tap to change`}>{demo.speed}×</button>
        <button className="btn btn-ghost btn-sm sq" onClick={() => run(api.demo.reset)} aria-label="Reset demo"><Icon.Reset size={18} /></button>
        <button className="btn btn-ghost btn-sm src" onClick={() => setAuto(!demo.scripted)} aria-label={`Water source: ${demo.scripted ? 'automatic flood' : 'live sensor'}, tap to switch`}>{demo.scripted ? 'Auto' : 'Live'}</button>
        {err && <span className="st-flooded" style={{ fontSize: 12 }}>{err}</span>}
      </div>
    )
  }

  return (
    <div className="card demo-panel" aria-label="Demo controls">
      <div className="row">
        <span className="tag-demo">DEMO</span>
        <span style={{ fontWeight: 600 }}>{demoClock}</span>
        <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Collapse demo panel">
          <span style={{ transform: open ? 'none' : 'rotate(180deg)', display: 'grid' }}><Icon.Chevron size={20} /></span>
        </button>
      </div>
      {open && (
        <>
          <div className="seg" role="group" aria-label="Water source" style={{ marginTop: 12 }}>
            <button aria-pressed={demo.scripted} onClick={() => setAuto(true)}>Automatic flood</button>
            <button aria-pressed={!demo.scripted} onClick={() => setAuto(false)}>Live sensor</button>
          </div>
          <div className="muted src-hint">
            {demo.scripted ? 'Plays a scripted 2-minute rise through the sensor.' : 'Uses real readings from the sensor. Add water to flood it.'}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-dark grow" onClick={toggle}>{playing ? <Icon.Pause size={18} /> : <Icon.Play size={18} />}{label}</button>
            <button className="btn btn-ghost" onClick={() => run(api.demo.reset)}><Icon.Reset size={18} />Reset</button>
          </div>
          <div className="speed">
            <div className="row" style={{ justifyContent: 'space-between', fontWeight: 600, fontSize: 14 }}><span>Speed</span><span>{demo.speed}×</span></div>
            <input type="range" min={0.5} max={4} step={0.5} value={demo.speed} aria-label="Demo speed"
              onChange={(e) => run(() => api.demo.speed(Number(e.target.value)))} />
          </div>
          {sensor && (
            <div className="foot">
              <span>{sensor.name}</span>
              <span className={`st-${sensor.current.status}`} style={{ fontSize: 17, fontWeight: 800 }}>
                {sensor.current.depth_cm != null ? `${Math.round(sensor.current.depth_cm)} cm · ` : ''}{STATUS_LABEL[sensor.current.status]}
              </span>
            </div>
          )}
          {liveDown && <div className="st-caution" style={{ fontSize: 13, fontWeight: 600, marginTop: 8 }}>The sensor isn't reporting. Switch to Automatic flood or check the device.</div>}
          {err && <div className="st-flooded" style={{ fontSize: 13, fontWeight: 600, marginTop: 8 }}>{err}</div>}
        </>
      )}
    </div>
  )
}

export function TripStats() {
  const drive = useDrive()
  const r = drive.active
  if (!r) return null
  return <span className="muted" style={{ fontWeight: 600 }}>{fmtDuration(r.duration_s)} · {fmtMiles(r.distance_m)} mi</span>
}

/** Car is holding before water/a stalled car and the big alert was dismissed: keep offering the reroute. */
