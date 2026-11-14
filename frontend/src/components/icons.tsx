import type { Status } from '../types'

// Each status has its own shape (design rule): ✓ circle, ! triangle, ✕ octagon, – dashed circle.
export function StatusIcon({ status, size = 22 }: { status: Status; size?: number }) {
  const s = size
  switch (status) {
    case 'clear':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="11" fill="#14A35A" stroke="#fff" strokeWidth="1.5" />
          <path d="M7 12.4l3.2 3.1L17.2 8.8" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'caution':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M12 1.8L23 21.5H1z" fill="#F2B300" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M12 8.5v6" stroke="#2B1F00" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="12" cy="18" r="1.5" fill="#2B1F00" />
        </svg>
      )
    case 'flooded':
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <path d="M7.4 1h9.2L23 7.4v9.2L16.6 23H7.4L1 16.6V7.4z" fill="#E5243B" stroke="#fff" strokeWidth="1.5" />
          <path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
        </svg>
      )
    default:
      return (
        <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#6B7684" strokeWidth="2" strokeDasharray="3.2 2.6" />
          <path d="M7.5 12h9" stroke="#6B7684" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      )
  }
}

type P = { size?: number; className?: string }
const base = (size = 22) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true })

export const Icon = {
  Map: ({ size }: P) => <svg {...base(size)}><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" /></svg>,
  Wheel: ({ size }: P) => <svg {...base(size)}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2" /><path d="M12 14v7M10 12H3.5M14 12h6.5" /></svg>,
  Bell: ({ size }: P) => <svg {...base(size)}><path d="M6 16V11a6 6 0 1112 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 004 0" /></svg>,
  Close: ({ size }: P) => <svg {...base(size)}><path d="M6 6l12 12M18 6L6 18" /></svg>,
  Search: ({ size }: P) => <svg {...base(size)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>,
  Clock: ({ size }: P) => <svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>,
  Play: ({ size }: P) => <svg {...base(size)} fill="currentColor" stroke="none"><path d="M7 4.5v15l12-7.5z" /></svg>,
  Pause: ({ size }: P) => <svg {...base(size)} fill="currentColor" stroke="none"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>,
  Reset: ({ size }: P) => <svg {...base(size)}><path d="M4 12a8 8 0 108-8 8.5 8.5 0 00-6 2.6L4 8.5" /><path d="M4 4v4.5h4.5" /></svg>,
  Chevron: ({ size }: P) => <svg {...base(size)}><path d="M6 9l6 6 6-6" /></svg>,
  Reroute: ({ size }: P) => <svg {...base(size)}><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="6" r="2.5" /><path d="M8.5 18H16a3 3 0 000-6H8a3 3 0 010-6h7.5" /></svg>,
  Shield: ({ size }: P) => <svg {...base(size)}><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z" /><path d="M8.5 12l2.5 2.5 4.5-5" /></svg>,
  Broadcast: ({ size }: P) => <svg {...base(size)}><circle cx="12" cy="12" r="2" /><path d="M8.5 8.5a5 5 0 000 7M15.5 8.5a5 5 0 010 7M5.6 5.6a9 9 0 000 12.8M18.4 5.6a9 9 0 010 12.8" /></svg>,
  Sound: ({ size }: P) => <svg {...base(size)}><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" /></svg>,
  Vibrate: ({ size }: P) => <svg {...base(size)}><rect x="8" y="3" width="8" height="18" rx="2" /><path d="M4 8v8M20 8v8" /></svg>,
  Turn: ({ size }: P) => <svg {...base(size)}><path d="M7 20v-8a4 4 0 014-4h8" /><path d="M15 4l4 4-4 4" /></svg>,
  Flag: ({ size }: P) => <svg {...base(size)}><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></svg>,
  Pin: ({ size }: P) => <svg {...base(size)}><path d="M12 21s-7-6.2-7-11.5a7 7 0 0114 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></svg>,
  Locate: ({ size }: P) => <svg {...base(size)}><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>,
  Car: ({ size }: P) => <svg {...base(size)}><path d="M5 16l1.6-5.2A2 2 0 018.5 9.4h7a2 2 0 011.9 1.4L19 16" /><rect x="3.5" y="15.5" width="17" height="4" rx="1.5" /><circle cx="7.5" cy="19.5" r="1.3" /><circle cx="16.5" cy="19.5" r="1.3" /></svg>,
  Wifi: ({ size }: P) => <svg {...base(size)}><path d="M2.5 8.5a14 14 0 0119 0M5.5 12a9.5 9.5 0 0113 0M8.5 15.5a5 5 0 017 0" /><circle cx="12" cy="19" r="1" fill="currentColor" /></svg>,
  Settings: ({ size }: P) => <svg {...base(size)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" /></svg>,
  Arrow: ({ size }: P) => <svg width={size ?? 16} height={size ?? 16} viewBox="0 0 24 24" aria-hidden><path d="M12 3l7 17-7-4-7 4z" fill="#fff" /></svg>,
}

export function Brand() {
  return (
    <div className="brand" aria-label="FloodRoute">
      <span className="brand-word">fl<b>oo</b>d<b>route</b></span>
    </div>
  )
}
