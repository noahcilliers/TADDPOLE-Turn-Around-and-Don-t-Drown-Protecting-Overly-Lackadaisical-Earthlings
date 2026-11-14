import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { ago, clock, depthText, minsSince, STATUS_LABEL, trend } from '../format'
import { updateSettings, useStore } from '../store'
import type { Range, Series, Stats, Status, StatusChange } from '../types'
import { Icon, StatusIcon } from './icons'

const RANGE_LABEL: Record<Range, string> = { '1h': 'Past hour', '6h': '6 h', '24h': '24 h' }
const STATUS_COLOR: Record<Status, string> = { clear: '#14A35A', caution: '#F2B300', flooded: '#E5243B', offline: '#8A93A0' }

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(id) }, [ms])
  return now
}

export function DepthChart({ series, status, caution, flooded }: { series: Series | null; status: Status; caution: number; flooded: number }) {
  const W = 400, H = 190
  const pts = series?.points ?? []
  const vals = pts.map((p) => p.depth_cm).filter((v): v is number => v != null)
  const peak = vals.length ? Math.max(...vals) : 0
  const ymax = Math.max(flooded + 5, peak * 1.15)
  const x = (i: number) => (pts.length > 1 ? (i / (pts.length - 1)) * W : 0)
  const y = (v: number) => H - (v / ymax) * H

  const { line, area } = useMemo(() => {
    let line = '', area = ''
    let run: [number, number][] = []
    const flush = () => {
      if (run.length) {
        line += 'M' + run.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')
        area += `M${run[0][0].toFixed(1)},${H}L` + run.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L') + `L${run[run.length - 1][0].toFixed(1)},${H}Z`
      }
      run = []
    }
    pts.forEach((p, i) => { if (p.depth_cm == null) flush(); else run.push([x(i), y(p.depth_cm)]) })
    flush()
    return { line, area }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, ymax])

  // trailing gap (sensor offline): hatched "no data" block
  let gapStart = pts.length
  while (gapStart > 0 && pts[gapStart - 1].depth_cm == null) gapStart--
  const trailingGap = pts.length > 0 && gapStart < pts.length
  let lastIdx = gapStart - 1
  const last = lastIdx >= 0 ? pts[lastIdx].depth_cm : null
  if (lastIdx < 0) lastIdx = 0
  const fill = status === 'flooded' ? '#FDE8EB' : status === 'caution' ? '#FFF3C4' : '#DCEADF'
  const stroke = status === 'offline' ? '#6B7684' : '#0F172A'
  const t0 = pts[0]?.t, tm = pts[Math.floor(pts.length / 2)]?.t

  return (
    <div className="chart">
      <div className="chart-head"><span>Water depth</span><span>max {Math.round(ymax)} cm</span></div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Water depth chart, peak ${Math.round(peak)} cm`}>
        <defs>
          <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="#CBD5E1" strokeWidth="2" />
          </pattern>
        </defs>
        <rect x="0" y="0" width={W} height={y(flooded)} fill="#FDE8EB" opacity="0.7" />
        <line x1="0" x2={W} y1={y(flooded)} y2={y(flooded)} stroke="#E5243B" strokeDasharray="5 5" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <line x1="0" x2={W} y1={y(caution)} y2={y(caution)} stroke="#B58800" strokeDasharray="5 5" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <path d={area} fill={fill} opacity="0.9" />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {trailingGap && <rect x={x(Math.max(0, gapStart - 1))} y="0" width={W - x(Math.max(0, gapStart - 1))} height={H} fill="url(#hatch)" opacity="0.8" />}
        {last != null && <circle cx={x(lastIdx)} cy={y(last)} r="5" fill={STATUS_COLOR[status]} stroke="#fff" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="chart-x">
        <span>{t0 ? clock(t0, true) : ''}</span><span>{tm ? clock(tm) : ''}</span><span>Now</span>
      </div>
      <div className="row" style={{ gap: 14, fontSize: 12, fontWeight: 700, marginTop: 6 }}>
        <span style={{ color: '#BE1230' }}>— Flooded {flooded} cm</span>
        <span style={{ color: '#7A5600' }}>— Caution {caution} cm</span>
        {trailingGap && <span className="muted">▨ no data</span>}
      </div>
    </div>
  )
}

export default function SensorPanel({ id, onClose, compact = false }: { id: string; onClose?: () => void; compact?: boolean }) {
  const sensor = useStore((s) => s.sensors[id])
  const config = useStore((s) => s.config)
  const units = useStore((s) => s.settings.units)
  const now = useNow()
  const [range, setRange] = useState<Range>('1h')
  const [series, setSeries] = useState<Series | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [changes, setChanges] = useState<StatusChange[]>([])
  const [err, setErr] = useState<string | null>(null)
  const reading = sensor?.current.last_reading_at

  useEffect(() => {
    let cancelled = false
    const load = () => Promise.all([api.series(id, range), api.stats(id, range), api.statusChanges(id)])
      .then(([se, st, ch]) => { if (!cancelled) { setSeries(se); setStats(st); setChanges(ch); setErr(null) } })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : 'Could not load history') })
    void load()
    const t = window.setInterval(load, range === '1h' ? 10_000 : 60_000)
    return () => { cancelled = true; window.clearInterval(t) }
  }, [id, range])

  // refresh quickly after a status change for this sensor
  const status = sensor?.current.status
  useEffect(() => {
    if (!status) return
    api.statusChanges(id).then(setChanges).catch(() => {})
    api.series(id, range).then(setSeries).catch(() => {})
    api.stats(id, range).then(setStats).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  if (!sensor) return <div className="empty">Sensor not found</div>
  const c = sensor.current
  const caution = config?.thresholds.caution_cm ?? 10
  const flooded = config?.thresholds.flooded_cm ?? 30
  const offline = c.status === 'offline'
  const lastKnown = offline ? [...(series?.points ?? [])].reverse().find((p) => p.depth_cm != null)?.depth_cm ?? null : null
  const dt = depthText(c.depth_cm, units)
  const tr = trend(c.rate_cm_per_min)
  const stCls = `st-${c.status}`

  return (
    <section aria-label={`${sensor.name} details`}>
      <div className="sp-head">
        <div className="grow">
          <div className={`sp-status ${stCls}`}>
            <StatusIcon status={c.status} size={18} />
            {offline
              ? <span>Offline · {reading ? `No reading for ${minsSince(reading, now)} min` : 'never reported'}</span>
              : <span>{STATUS_LABEL[c.status]} · Updated {ago(reading, now)}</span>}
          </div>
          <div className="sp-name">{sensor.name}</div>
          <div className="sp-road">{sensor.road ?? ''} {sensor.simulated && <span className="badge-sim" title="Replayed sample data, not a live device">Simulated</span>}</div>
        </div>
        <FollowButton id={sensor.id} />
        {onClose && <button className="icon-btn" onClick={onClose} aria-label="Close sensor"><Icon.Close size={20} /></button>}
      </div>

      <div className="depth">
        <div>
          <div><span className="depth-big">{dt.big}</span><span className="depth-unit">{dt.unit}</span></div>
          <div className="depth-small">{offline ? `Last reading ${reading ? clock(reading) : '—'}` : dt.small}</div>
        </div>
        {offline ? <span className="trend">No data</span> : <span className={`trend ${tr.dir}`}>{tr.dir === 'up' && '↗ '}{tr.label}</span>}
      </div>

      {offline && (
        <div className="offline-note">
          <b>Treat this dip as unknown, not safe.</b> {lastKnown != null ? `Last reading was ${Math.round(lastKnown)} cm at ${reading ? clock(reading) : '—'}. ` : ''}Routes avoid it while it's offline.
        </div>
      )}

      {compact ? null : (
        <>
          <div className="seg" role="group" aria-label="Chart range" style={{ marginTop: 6 }}>
            {(['1h', '6h', '24h'] as Range[]).map((r) => (
              <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{RANGE_LABEL[r]}</button>
            ))}
          </div>
          {err && <div className="offline-note">History unavailable: {err}</div>}
          <DepthChart series={series} status={c.status} caution={caution} flooded={flooded} />
          <div className="stats">
            <div className="stat"><div className="k">Peak</div><div className="v">{stats?.peak_cm != null ? `${Math.round(stats.peak_cm)} cm` : '—'}</div><div className="s">{stats?.peak_at ? `at ${clock(stats.peak_at)}` : 'no data'}</div></div>
            <div className="stat"><div className="k">Fastest rise</div><div className="v">{stats?.fastest_rise_cm_per_min != null ? `${stats.fastest_rise_cm_per_min >= 0 ? '+' : ''}${stats.fastest_rise_cm_per_min.toFixed(1)} cm/min` : '—'}</div><div className="s">5-min window</div></div>
            <div className="stat"><div className="k">Above caution</div><div className="v">{fmtMins(stats?.minutes_above_caution)}</div><div className="s">{caution} cm or more</div></div>
            <div className="stat"><div className="k">Flooded</div><div className="v">{fmtMins(stats?.minutes_flooded)}</div><div className="s">{flooded} cm or more</div></div>
          </div>
          <div className="section-h">Status changes · last 24 h</div>
          {changes.length === 0 ? <div className="muted" style={{ fontWeight: 600, padding: '8px 0' }}>No changes in the last 24 h</div> : (
            <ul className="changes">
              {changes.map((ch, i) => (
                <li key={i}>
                  <span className={`st-${ch.from_status ?? 'clear'}`}>{ch.from_status ? STATUS_LABEL[ch.from_status] : 'Start'}</span>
                  <span aria-hidden>→</span>
                  <span className={`st-${ch.to_status}`} style={{ fontWeight: 800 }}>{STATUS_LABEL[ch.to_status]}</span>
                  <span className="muted" style={{ fontWeight: 600 }}>{ch.to_status === 'offline' ? 'no reading' : ch.depth_cm != null ? `${Math.round(ch.depth_cm)} cm` : ''}</span>
                  <span className="t">{clock(ch.time, true)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="health">
            <div><div className="k">Sensor</div><div className="v ellipsis">{sensor.id}</div></div>
            <div><div className="k">Battery</div><div className={`v ${sensor.battery_pct != null && sensor.battery_pct < 20 ? 'st-flooded' : ''}`}>{sensor.battery_pct != null ? `${sensor.battery_pct}%` : '—'}</div></div>
            <div><div className="k">Signal</div><div className={`v ${sensor.signal === 'lost' ? 'st-flooded' : ''}`} style={{ textTransform: 'capitalize' }}>{sensor.signal ?? '—'}</div></div>
            <div><div className="k">Calibrated</div><div className="v">{sensor.calibrated_at ? new Date(sensor.calibrated_at + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</div></div>
          </div>
        </>
      )}
    </section>
  )
}

function fmtMins(m: number | null | undefined) {
  if (m == null) return '—'
  return m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`
}

function FollowButton({ id }: { id: string }) {
  const following = useStore((s) => s.settings.following)
  const on = following.includes(id)
  return (
    <button className="icon-btn" aria-pressed={on} title={on ? 'Following: alerts in your feed' : 'Follow this sensor'}
      onClick={() => updateSettings({ following: on ? following.filter((x) => x !== id) : [...following, id] })}
      style={on ? { background: 'var(--blue-soft)', color: 'var(--blue)' } : undefined}>
      <Icon.Bell size={19} />
    </button>
  )
}
