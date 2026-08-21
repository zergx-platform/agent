import { Hono } from 'hono'
import type { AppEnv } from '../context.js'
import { configRoutes } from './config.js'
import { providerRoutes } from './providers.js'
import { sessionRoutes } from './sessions.js'

export function buildRoutes() {
  const api = new Hono<AppEnv>().get('/health', c =>
    c.json({ ok: true, name: 'rucoder-agent-ts' }),
  )

  const routed = api
    .route('/sessions', sessionRoutes)
    .route('/providers', providerRoutes)
    // configRoutes uses flat paths (/presets /config ...) mounted at the root.
    .route('/', configRoutes)

  return routed
}
