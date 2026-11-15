import { useEffect, useState } from 'react'
import { DriveProvider } from './drive'
import { Phone, Stage } from './layouts'
import { connectLive } from './store'

function useLayout(): 'stage' | 'phone' {
  const forced = new URLSearchParams(location.search).get('view')
  const q = () => (forced === 'stage' || forced === 'phone' ? forced : window.innerWidth >= 1024 ? 'stage' : 'phone')
  const [v, setV] = useState<'stage' | 'phone'>(q)
  useEffect(() => {
    const on = () => setV(q())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return v
}

export default function App() {
  const layout = useLayout()
  useEffect(() => { connectLive() }, [])
  return (
    <DriveProvider>
      {layout === 'stage' ? <Stage /> : <Phone />}
    </DriveProvider>
  )
}
