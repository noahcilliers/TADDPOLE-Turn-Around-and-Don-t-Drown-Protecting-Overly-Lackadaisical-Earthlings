import { useMemo, useState } from 'react'
import { useDrive } from '../drive'
import { clock, ago, minsSince, STATUS_LABEL, STATUS_RANK, trend } from '../format'
import { dist, project } from '../geo'
import { useStore } from '../store'
import type { FeedEvent, LngLat, Sensor } from '../types'
import { useNow } from './SensorPanel'
import { Icon, StatusIcon } from './icons'

type Sort = 'risk' | 'near' | 'route'

function sublabel(s: Sensor, now: number): string {
  const c = s.current
  if (c.status === 'offline') return `Offline · no reading for ${minsSince(c.last_reading_at, now) ?? '—'} min`
  const tr = trend(c.rate_cm_per_min)
  const t = tr.dir === 'up' ? `rising ${c.rate_cm_per_min!.toFixed(1)} cm/min` : tr.dir === 'down' ? `falling ${Math.abs(c.rate_cm_per_min!).toFixed(1)} cm/min` : 'steady'
  return `${STATUS_LABEL[c.status]} · ${t}`
}

export function SensorList({ onSelect, selectedId, title }: { onSelect: (id: string) => void; selectedId?: string | null; title?: boolean }) {
  const sensorsMap = useStore((s) => s.sensors)
  const drive = useDrive()
  const now = useNow(5000)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('risk')
  const me: LngLat | null = drive.car?.pos ?? drive.origin

  const rows = useMemo(() => {
    let list = Object.values(sensorsMap)
    if (q.trim()) {
      const n = q.toLowerCase()
      list = list.filter((s) => s.name.toLowerCase().includes(n) || (s.road ?? '').toLowerCase().includes(n) || s.id.toLowerCase().includes(n))
    }
    const withD = list.map((s) => ({ s, d: me ? dist(me, s.location.coordinates) : null }))
    if (sort === 'route') {
      const path = drive.active?.geometry.coordinates
      return withD.filter(({ s }) => path && project(path, s.location.coordinates).off_m < 40)
        .sort((a, b) => project(drive.active!.geometry.coordinates, a.s.location.coordinates).along_m - project(drive.active!.geometry.coordinates, b.s.location.coordinates).along_m)
    }
    if (sort === 'near') return withD.sort((a, b) => (a.d ?? 0) - (b.d ?? 0))
    return withD.sort((a, b) => STATUS_RANK[a.s.current.status] - STATUS_RANK[b.s.current.status] || (b.s.current.depth_cm ?? -1) - (a.s.current.depth_cm ?? -1))
  }, [sensorsMap, q, sort, me, drive.active])

  return (
    <div>
      {title && <h1>Sensors</h1>}
      <label className="search"><Icon.Search size={19} /><span className="sr-only">Search sensors</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a street or intersection" />
      </label>
      <div className="seg" role="group" aria-label="Sort sensors" style={{ marginTop: 12 }}>
        <button aria-pressed={sort === 'risk'} onClick={() => setSort('risk')}>Most at risk</button>
        <button aria-pressed={sort === 'near'} onClick={() => setSort('near')}>Nearest</button>
        <button aria-pressed={sort === 'route'} onClick={() => setSort('route')}>On my route</button>
      </div>
      <div className="muted" style={{ fontSize: 13, fontWeight: 600, margin: '12px 0 2px' }}>
        {rows.length} sensor{rows.length === 1 ? '' : 's'} · {sort === 'risk' ? 'most at risk first' : sort === 'near' ? 'nearest first' : 'in route order'}
      </div>
      <ul className="list">
        {rows.map(({ s, d }) => (
          <li key={s.id}>
            <button className="list-item" onClick={() => onSelect(s.id)} aria-current={selectedId === s.id} style={selectedId === s.id ? { background: 'var(--blue-soft)' } : undefined}>
              <StatusIcon status={s.current.status} size={24} />
              <div className="grow">
                <div className="title ellipsis">{s.name} {s.simulated ? '' : <span className="badge-sim" style={{ background: 'var(--green-soft)', color: 'var(--green-ink)' }}>Live device</span>}</div>
                <div className={`sub st-${s.current.status}`}>{sublabel(s, now)}</div>
              </div>
              <div className="val">{s.current.depth_cm != null ? `${Math.round(s.current.depth_cm)} cm` : '—'}
                {d != null && <small>{(d / 1609.344).toFixed(1)} mi</small>}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {rows.length === 0 && <div className="empty">{sort === 'route' ? 'No sensors on your current route.' : 'No sensors match.'}</div>}
    </div>
  )
}

type Filter = 'all' | 'near' | 'route' | 'following'

export function AlertFeed({ onSelect, title }: { onSelect?: (id: string) => void; title?: boolean }) {
  const feed = useStore((s) => s.feed)
  const sensors = useStore((s) => s.sensors)
  const following = useStore((s) => s.settings.following)
  const drive = useDrive()
  const now = useNow(15_000)
  const [filter, setFilter] = useState<Filter>('all')
  const me = drive.car?.pos ?? drive.origin

  const items = useMemo(() => feed.filter((e) => {
    if (filter === 'all') return true
    if (e.kind === 'local') return filter === 'route'
    const s = e.sensor_id ? sensors[e.sensor_id] : undefined
    if (!s) return false
    if (filter === 'following') return following.includes(s.id)
    if (filter === 'near') return me ? dist(me, s.location.coordinates) <= 3000 : true
    const path = drive.active?.geometry.coordinates
    return !!path && project(path, s.location.coordinates).off_m < 40
  }), [feed, filter, sensors, following, me, drive.active])

  return (
    <div>
      {title && <h1>Alerts</h1>}
      <div className="filters" role="group" aria-label="Filter alerts">
        {([['all', 'All'], ['near', 'Near me'], ['route', 'My routes'], ['following', 'Following']] as [Filter, string][]).map(([k, l]) => (
          <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <ul className="list">
        {items.map((e) => <FeedRow key={e.id} e={e} now={now} onSelect={onSelect} />)}
      </ul>
      {items.length === 0 && <div className="empty">{filter === 'following' ? 'Follow a sensor (bell on its card) to see it here.' : 'Nothing yet. Status changes and reports appear here live.'}</div>}
    </div>
  )
}

function FeedRow({ e, now, onSelect }: { e: FeedEvent; now: number; onSelect?: (id: string) => void }) {
  const tone = e.local?.tone
  const icon = e.kind === 'local'
    ? <span className="ic blue" style={tone === 'red' ? { background: '#FDE8EB', color: '#BE1230' } : tone === 'yellow' ? { background: '#FFF3C4', color: '#7A5600' } : tone === 'green' ? { background: '#DCEADF', color: '#0A6B37' } : undefined}>
        {e.local?.icon === 'flag' ? <Icon.Flag size={17} /> : <Icon.Shield size={17} />}
      </span>
    : e.kind === 'hazard' ? <span className="ic" style={{ background: 'var(--red)', color: '#fff' }}><Icon.Car size={17} /></span>
    : <span className="ic"><StatusIcon status={e.to_status ?? 'clear'} size={24} /></span>
  const clickable = !!(onSelect && e.sensor_id)
  const body = (
    <>
      {icon}
      <div className="grow">
        <div className="title">{e.title}</div>
        {e.kind === 'status_change' && e.to_status && (
          <div className="line2"><span className={`st-${e.from_status ?? 'clear'}`}>{e.from_status ? STATUS_LABEL[e.from_status] : 'Start'}</span> → <span className={`st-${e.to_status}`}>{STATUS_LABEL[e.to_status]}</span></div>
        )}
        <div className="line3">{e.detail}{e.detail ? ' · ' : ''}{ago(e.time, now)}</div>
      </div>
      <div className="time">{clock(e.time)}</div>
    </>
  )
  return (
    <li>
      {clickable
        ? <button className="feed-item" style={{ width: '100%', textAlign: 'left' }} onClick={() => onSelect!(e.sensor_id!)}>{body}</button>
        : <div className="feed-item">{body}</div>}
    </li>
  )
}
