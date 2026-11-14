import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, /v1 (REST + the /v1/live WebSocket) is proxied to the FastAPI backend.
// In production Caddy serves the built files and proxies /v1 on the same origin.
const backend = process.env.BACKEND_URL ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: backend, changeOrigin: true, ws: true },
    },
  },
})
