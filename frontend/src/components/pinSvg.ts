import type { Status } from '../types'

// Same shapes as <StatusIcon>, as strings for Leaflet divIcons (no react-dom/server in the bundle).
export function statusSvg(status: Status, s: number): string {
  switch (status) {
    case 'clear':
      return `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#14A35A" stroke="#fff" stroke-width="1.5"/><path d="M7 12.4l3.2 3.1L17.2 8.8" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    case 'caution':
      return `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M12 1.8L23 21.5H1z" fill="#F2B300" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 8.5v6" stroke="#2B1F00" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="18" r="1.5" fill="#2B1F00"/></svg>`
    case 'flooded':
      return `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M7.4 1h9.2L23 7.4v9.2L16.6 23H7.4L1 16.6V7.4z" fill="#E5243B" stroke="#fff" stroke-width="1.5"/><path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>`
    default:
      return `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#6B7684" stroke-width="2" stroke-dasharray="3.2 2.6"/><path d="M7.5 12h9" stroke="#6B7684" stroke-width="2.4" stroke-linecap="round"/></svg>`
  }
}
