import { useState } from 'react'
import { api, ApiError, getDemoKey, setDemoKey } from '../api'
import { alertHeadline, useDrive, type DriveAlert } from '../drive'
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

function MiniMap() {
  return (
    <svg width="92" height="92" viewBox="0 0 92 92" aria-hidden>
      <rect width="92" height="92" fill="#EEF1F5" />
      <path d="M46 0v92M0 34h92" stroke="#fff" strokeWidth="10" />
      <path d="M46 20v40" stroke="#E5243B" strokeWidth="8" strokeLinecap="round" opacity=".85" />
      <g transform="translate(34 32)"><path d="M7 0h10l7 7v10l-7 7H7L0 17V7z" fill="#E5243B" stroke="#fff" strokeWidth="2" /><path d="M8 8l8 8M16 8l-8 8" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" /></g>
    </svg>
  )
}

export function AlertOverlay({ alert }: { alert: DriveAlert }) {
  const drive = useDrive()
  const units = useStore((s) => s.settings.units)
  const { title, sub } = alertHeadline(alert)
  const depth = alert.sensor?.current.depth_cm
  const mi = fmtMiles(alert.distance_m)
  if (alert.level === 'caution') {
    const s = alert.sensor!
    const rate = s.current.rate_cm_per_min
    return (
      <div className="alert-yellow" role="alert">
        <div className="kicker"><StatusIcon status="caution" size={18} /> Water rising ahead</div>
        <div className="body">
          <div className="grow">
            <div className="name">{s.name}</div>
            <div className="meta">{depth != null ? `${Math.round(depth)} cm${units !== 'cm' ? ` · ${(depth / 2.54).toFixed(1)} in` : ''}` : ''}{rate != null && rate > 0.3 ? ` · rising ${rate.toFixed(1)} cm/min` : ''}</div>
          </div>
          <div className="num">{mi}<small>mi ahead</small></div>
        </div>
        <div className="actions">
          <button className="btn btn-dark" onClick={drive.rerouteNow}><Icon.Reroute size={19} />Find another way</button>
          <button className="btn btn-ghost" onClick={drive.dismissAlert}>Got it</button>
        </div>
      </div>
    )
  }
  const closing = alert.closing_s != null ? `closing · ~${Math.max(1, Math.round(alert.closing_s))} s`
    : alert.distance_m > 150 ? 'car paused · choose below' : 'stopped'
  return (
    <div className="alert-red" role="alert" aria-live="assertive">
      <div className="kicker">
        <StatusIcon status="flooded" size={24} />{alert.level === 'stalled' ? `Reported by the car ahead · ${alert.hazard ? ago(alert.hazard.created_at) : 'just now'}` : 'Flood alert'}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }} aria-hidden><Icon.Sound size={20} /><Icon.Vibrate size={20} /></span>
      </div>
      <h2>{title}</h2>
      <div className="sub">{sub}</div>
      <div className="dist">
        <div>
          <div className="n">{mi}<small>mi</small></div>
          <div className="meta">{closing}{depth != null ? ` · ${Math.round(depth)} cm deep` : ''}</div>
        </div>
        <div className="mini"><MiniMap /></div>
      </div>
      {alert.level === 'stalled' && alert.distance_m > 1000 && <div style={{ fontWeight: 600, marginBottom: 10, opacity: .95 }}>Warned early, outside the usual 1 km zone.</div>}
      <div className="slogan">Turn around, don't drown.</div>
      <div className="actions">
        <button className="btn btn-white" onClick={drive.rerouteNow}><Icon.Reroute size={20} />Reroute</button>
        <button className="btn btn-dismiss" onClick={drive.dismissAlert}>Dismiss</button>
      </div>
    </div>
  )
}

export function ToastView() {
  const { toast } = useDrive()
  if (!toast) return null
  return (
    <div className="toast" role="status" aria-live="polite">
      <div className="ic" style={toast.tone === 'green' ? { background: 'var(--green)' } : toast.tone === 'red' ? { background: 'var(--red)' } : undefined}>
        {toast.tone === 'green' ? <Icon.Flag size={26} /> : toast.tone === 'red' ? <StatusIcon status="flooded" size={30} /> : <Icon.Shield size={26} />}
      </div>
      <div><div className="t">{toast.title}</div><div className="d">{toast.detail}</div></div>
    </div>
  )
}

export function RouteCard() {
  const drive = useDrive()
  const look = useStore((s) => s.settings.lookahead_m)
  const sensors = useStore((s) => s.sensors)
  const r = drive.active
  if (!r || !drive.destination) return null
  if (drive.mode === 'watch') {
    return (
      <div className="card route-card">
        <div className="ic"><Icon.Broadcast size={24} /></div>
        <div className="grow">
          <div className="k st-clear" style={{ color: 'var(--blue)' }}>Watching for floods</div>
          <div className="d">Warns you about anything within {look >= 1000 ? `${look / 1000} km` : `${look} m`} ahead</div>
        </div>
      </div>
    )
  }
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
  if (!r || drive.mode !== 'nav' || !r.steps.length) return null
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
  const toggle = () => run(() => (playing ? api.demo.pause() : api.demo.start(drive.mode, demo.speed)))
  // demo clock shown as Phoenix time, 1 demo s = 10 real s (handoff), starting 6:40 PM
  const demoClock = clock(new Date(Date.parse('2026-08-15T01:40:00Z') + drive.demoS * 10_000))

  if (variant === 'phone') {
    return (
      <div className="demo-row" aria-label="Demo controls">
        <span className="tag-demo">DEMO</span>
        <button className="btn btn-dark btn-sm grow" style={{ height: 46 }} onClick={toggle}>{playing ? <Icon.Pause size={18} /> : <Icon.Play size={18} />}{label}</button>
        <button className="btn btn-ghost btn-sm sq" onClick={() => run(() => api.demo.speed(demo.speed >= 4 ? 1 : demo.speed * 2))} aria-label={`Speed ${demo.speed}×, tap to change`}>{demo.speed}×</button>
        <button className="btn btn-ghost btn-sm sq" onClick={() => run(api.demo.reset)} aria-label="Reset demo"><Icon.Reset size={18} /></button>
        <label className="btn btn-ghost btn-sm stall">
          <span className="switch danger mini"><input type="checkbox" checked={demo.stall} onChange={(e) => run(() => api.demo.stall(e.target.checked))} aria-label="Car stalled in the flood" /><span /></span>Stall
        </label>
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
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-dark grow" onClick={toggle}>{playing ? <Icon.Pause size={18} /> : <Icon.Play size={18} />}{label}</button>
            <button className="btn btn-ghost" onClick={() => run(api.demo.reset)}><Icon.Reset size={18} />Reset</button>
          </div>
          <div className="speed">
            <div className="row" style={{ justifyContent: 'space-between', fontWeight: 600, fontSize: 14 }}><span>Speed</span><span>{demo.speed}×</span></div>
            <input type="range" min={0.5} max={4} step={0.5} value={demo.speed} aria-label="Demo speed"
              onChange={(e) => run(() => api.demo.speed(Number(e.target.value)))} />
          </div>
          <div className="seg" role="group" aria-label="Driving mode" style={{ marginTop: 10 }}>
            <button aria-pressed={drive.mode === 'nav'} onClick={() => drive.setMode('nav')}>Navigate</button>
            <button aria-pressed={drive.mode === 'watch'} onClick={() => drive.setMode('watch')}>Watch only</button>
          </div>
          <label className="toggle-row">
            <span className="switch danger"><input type="checkbox" checked={demo.stall} onChange={(e) => run(() => api.demo.stall(e.target.checked))} /><span /></span>
            Car stalled in the flood
          </label>
          <label className="toggle-row" title="Replay the scripted depth curve instead of the real tub sensor">
            <span className="switch"><input type="checkbox" checked={demo.scripted} onChange={(e) => run(() => api.demo.scripted(e.target.checked))} /><span /></span>
            <span className="grow">Scripted flood <span className="muted" style={{ fontSize: 13 }}>{demo.scripted ? '(replaying curve)' : '(using real sensor)'}</span></span>
          </label>
          {sensor && (
            <div className="foot">
              <span>{sensor.name}</span>
              <span className={`st-${sensor.current.status}`} style={{ fontSize: 17, fontWeight: 800 }}>
                {sensor.current.depth_cm != null ? `${Math.round(sensor.current.depth_cm)} cm · ` : ''}{STATUS_LABEL[sensor.current.status]}
              </span>
            </div>
          )}
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
export function BlockedBar() {
  const drive = useDrive()
  if (!drive.blocked) return null
  const name = drive.blocked.sensor?.name ?? 'the road ahead'
  return (
    <div className="blocked-bar" role="status">
      <StatusIcon status="flooded" size={26} />
      <div className="grow">
        <div className="t">Stopped before {drive.blocked.hazard ? 'a stalled car' : 'flooded road'}</div>
        <div className="d ellipsis">{name}</div>
      </div>
      <button className="btn btn-white btn-sm" onClick={drive.rerouteNow}><Icon.Reroute size={18} />Reroute</button>
    </div>
  )
}
