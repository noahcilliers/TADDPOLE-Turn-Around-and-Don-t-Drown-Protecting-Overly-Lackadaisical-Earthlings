import { useEffect, useRef, useState } from 'react'
import { useDrive, type TripSummary } from '../drive'
import { clock, fmtDuration, fmtMiles } from '../format'
import { updateSettings, useStore, type Settings as S } from '../store'
import type { LngLat } from '../types'
import { DemoPanel } from './Overlays'
import { Brand, Icon, StatusIcon } from './icons'

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <span className="switch"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} /><span /></span>
}

export function SettingsPage() {
  const s = useStore((st) => st.settings)
  const row = (k: keyof S, t: string, d: string) => (
    <div className="setting">
      <div className="grow"><div className="t">{t}</div><div className="d">{d}</div></div>
      <Toggle checked={s[k] as boolean} onChange={(v) => updateSettings({ [k]: v } as Partial<S>)} label={t} />
    </div>
  )
  return (
    <div>
      <h1>Settings</h1>
      <div className="group-h">Warn me</div>
      <div className="t" style={{ fontWeight: 700, margin: '8px 0' }}>Look-ahead distance</div>
      <div className="seg" role="group" aria-label="Look-ahead distance">
        {([500, 1000, 2000] as const).map((m) => (
          <button key={m} aria-pressed={s.lookahead_m === m} onClick={() => updateSettings({ lookahead_m: m })}>{m < 1000 ? `${m} m` : `${m / 1000} km`}</button>
        ))}
      </div>
      {row('alert_rising', 'Rising water', 'Yellow card alerts')}
      {row('alert_flooded', 'Flooded roads', 'Full-width red alerts')}
      {row('alert_stalled', 'Stalled cars', 'Reports from drivers ahead')}
      <div className="group-h">While driving</div>
      {row('sound', 'Sound', 'Chime on red alerts')}
      {row('vibration', 'Vibration', 'On red alerts')}
      {row('avoid_offline', 'Avoid offline sensors', 'Treat as unknown, not clear')}
      <div className="group-h">Display</div>
      <div className="t" style={{ fontWeight: 700, margin: '8px 0' }}>Units</div>
      <div className="seg" role="group" aria-label="Units">
        {([['both', 'cm + in'], ['in', 'in only'], ['cm', 'cm only']] as const).map(([k, l]) => (
          <button key={k} aria-pressed={s.units === k} onClick={() => updateSettings({ units: k })}>{l}</button>
        ))}
      </div>
      <div className="group-h">Demo</div>
      <div className="muted" style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.5 }}>Demo controls need the backend's <code>ADMIN_TOKEN</code>. You'll be asked for it the first time you press Play, or open the app with <code>?demo_key=…</code>.</div>
      <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => updateSettings({ welcomed: false })}>Show welcome screen again</button>
    </div>
  )
}

export function Welcome() {
  const drive = useDrive()
  const done = (gps: boolean) => { if (gps) drive.enableGps(); updateSettings({ welcomed: true }) }
  return (
    <div className="welcome" role="dialog" aria-label="Welcome to FloodRoute">
      <div style={{ maxWidth: 460, margin: '0 auto', width: '100%' }}>
        <Brand />
        <h1>Know which roads are under water before you reach them.</h1>
        <p>Sensors at Phoenix's flood-prone dips report water depth live. FloodRoute warns you and finds a way around.</p>
        <div className="perm"><div className="ic"><Icon.Locate size={22} /></div><div><div className="t">Location while driving</div><div className="d">To warn you about flooded roads within 1 km ahead.</div></div></div>
        <div className="perm"><div className="ic"><Icon.Bell size={22} /></div><div><div className="t">Alerts with sound</div><div className="d">So you hear a warning without looking at your phone.</div></div></div>
        <button className="btn btn-blue" style={{ width: '100%', marginTop: 8, height: 54 }} onClick={() => done(true)}>Allow and start</button>
        <button className="btn" style={{ width: '100%', marginTop: 6, color: 'var(--ink-2)' }} onClick={() => done(false)}>Just browse the map</button>
      </div>
    </div>
  )
}

export function Summary({ trip, onDone }: { trip: TripSummary; onDone: () => void }) {
  const share = async () => {
    const text = `Arrived safely at ${trip.destination} with FloodRoute${trip.avoided.length ? `, avoided ${trip.avoided.map((a) => a.name).join(', ')}` : ''}.`
    try { if (navigator.share) await navigator.share({ text }); else await navigator.clipboard.writeText(text) } catch { /* cancelled */ }
  }
  return (
    <div>
      <div className="muted" style={{ fontWeight: 600, fontSize: 14 }}>{clock(trip.arrived_at)} · {trip.destination}</div>
      <h1 style={{ marginTop: 4 }}>You arrived safely</h1>
      <div className="stats" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <div className="stat"><div className="v">{fmtDuration(trip.duration_s)}</div><div className="s">drive time</div></div>
        <div className="stat"><div className="v">{fmtMiles(trip.distance_m)} mi</div><div className="s">distance</div></div>
        <div className="stat"><div className="v">+{Math.round(trip.delta_s / 60)} min</div><div className="s">for safety</div></div>
      </div>
      <ul className="list" style={{ marginTop: 12 }}>
        {trip.avoided.map((a) => (
          <li key={a.name} className="feed-item"><StatusIcon status="flooded" size={24} /><div><div className="title">Avoided {a.name}</div><div className="line3">{a.depth_cm != null ? `${Math.round(a.depth_cm)} cm deep when you were rerouted` : 'Flooded when you were rerouted'}</div></div></li>
        ))}
        {trip.passed.map((p) => (
          <li key={p.name} className="feed-item"><StatusIcon status={p.status as never} size={24} /><div><div className="title">Passed {p.name}</div><div className="line3">{p.depth_cm != null ? `${Math.round(p.depth_cm)} cm` : '—'} · {p.status}</div></div></li>
        ))}
        {trip.reroutes.map((t) => (
          <li key={t} className="feed-item"><span className="ic blue"><Icon.Clock size={17} /></span><div><div className="title">Rerouted at {clock(t)}</div><div className="line3">{trip.reroutes.length} alert{trip.reroutes.length > 1 ? 's' : ''}, no hard stops</div></div></li>
        ))}
      </ul>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn btn-ghost grow" onClick={share}>Share route</button>
        <button className="btn btn-blue grow" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

// ---------- destination search ----------
interface Place { name: string; lnglat: LngLat }
export function DestinationSearch({ onPicked, onPickOnMap }: { onPicked: (p: Place) => void; onPickOnMap?: () => void }) {
  const config = useStore((s) => s.config)
  const sensors = useStore((s) => s.sensors)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [results, setResults] = useState<Place[]>([])
  const timer = useRef<number | undefined>(undefined)

  // Free geocoding (OSM Nominatim), bounded to the map area. Debounced, ≤1 req/s.
  useEffect(() => {
    window.clearTimeout(timer.current)
    if (q.trim().length < 3 || !config?.bounds) { setResults([]); return }
    timer.current = window.setTimeout(async () => {
      const [w, s, e, n] = config.bounds!
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&bounded=1&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(q + ', Phoenix, AZ')}`
        const res = await fetch(url, { headers: { Accept: 'application/json' } })
        const data = (await res.json()) as { display_name: string; lon: string; lat: string }[]
        setResults(data.map((d) => ({ name: d.display_name.split(',').slice(0, 2).join(','), lnglat: [Number(d.lon), Number(d.lat)] })))
      } catch { setResults([]) }
    }, 650)
  }, [q, config?.bounds])

  const presets: Place[] = config ? [{ name: config.demo.destination_name, lnglat: config.demo.to }] : []
  const near = Object.values(sensors).filter((s) => q && s.name.toLowerCase().includes(q.toLowerCase())).map((s) => ({ name: s.name, lnglat: s.location.coordinates }))
  const pick = (p: Place) => { onPicked(p); setOpen(false); setQ('') }

  return (
    <div style={{ position: 'relative' }}>
      <label className="where"><Icon.Search size={22} /><span className="sr-only">Where to?</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setOpen(true)} placeholder="Where to?" style={{ border: 0, outline: 'none', flex: 1, fontSize: 17, fontWeight: 600, background: 'none' }} />
      </label>
      {open && (
        <div className="card suggest">
          {[...presets, ...near, ...results].slice(0, 7).map((p, i) => (
            <button key={i} onClick={() => pick(p)}><Icon.Pin size={18} /><span className="ellipsis">{p.name}</span></button>
          ))}
          {onPickOnMap && <button onClick={() => { setOpen(false); onPickOnMap() }}><Icon.Map size={18} />Pick a point on the map</button>}
          <button onClick={() => setOpen(false)} className="muted"><Icon.Close size={18} />Close</button>
        </div>
      )}
    </div>
  )
}

// ---------- phone drive sheet ----------
export function DriveSheet() {
  const drive = useDrive()
  const look = useStore((s) => s.settings.lookahead_m)
  const r = drive.active
  const remaining = r ? Math.max(0, r.distance_m - drive.traveled_m) : 0
  let title = 'Navigating', detail = drive.destination ? `${fmtMiles(remaining)} mi to ${drive.destination.name}` : 'Pick a destination'
  if (drive.mode === 'watch') { title = 'Watching for floods'; detail = `Warns you about anything within ${look >= 1000 ? `${look / 1000} km` : `${look} m`} ahead` }
  else if (drive.arrived) { title = 'Arrived'; detail = drive.destination?.name ?? '' }
  else if (r?.kind === 'safer') { title = 'Safer route' }
  else if (r && !r.safe) { title = 'Route crosses water'; detail = 'No flood-free route right now' }
  return (
    <div className="sheet">
      <div className="drive-head">
        <div className="ic" style={r && !r.safe && drive.mode === 'nav' ? { background: 'var(--red-soft)', color: 'var(--red)' } : undefined}><Icon.Wheel size={28} /></div>
        <div className="grow"><div className="t">{title}</div><div className="d">{detail}</div></div>
      </div>
      {drive.routeError && <div className="offline-note">Routing unavailable: {drive.routeError}</div>}
      <div className="seg" role="group" aria-label="Driving mode" style={{ marginTop: 14 }}>
        <button aria-pressed={drive.mode === 'nav'} onClick={() => drive.setMode('nav')}>Navigate</button>
        <button aria-pressed={drive.mode === 'watch'} onClick={() => drive.setMode('watch')}>Watch only</button>
      </div>
      <div className="dash-sep" />
      <DemoPanel variant="phone" />
    </div>
  )
}
