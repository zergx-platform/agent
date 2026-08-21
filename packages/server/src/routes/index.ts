import { Hono } from 'hono'
import type { AppEnv } from '../context.js'
import { configRoutes } from './config.js'
import { providerRoutes } from './providers.js'
import { sessionRoutes } from './sessions.js'

export function buildRoutes(): Hono<AppEnv> {
  const api = new Hono<AppEnv>()

  api.get('/health', c => c.json({ ok: true, name: 'rucoder-agent-ts' }))

  api.route('/sessions', sessionRoutes)
  api.route('/providers', providerRoutes)
  api.route('/', configRoutes) // presets, config, tool-config, tools, models, recore-config

  return api
}
