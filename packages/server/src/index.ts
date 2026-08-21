import { serve } from '@hono/node-server'
import {
  type AgentDeps,
  type Bus,
  connectBus,
  connectDb,
  type Db,
  LlmRegistry,
  loadConfig,
  Mailbox,
  refreshModelsDev,
  runSessionTurn,
  watchMailboxWake,
} from '@rucoder-agent/agent'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AppEnv } from './context.js'
import { buildRoutes } from './routes/index.js'

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

// `node:sea`'s `getRawAsset` is only available inside a single-executable
// application. We load it lazily via the CJS `require` (the whole server is
// bundled to CJS for SEA) so a normal `node` run does not crash at import.
function getSeaAsset(key: string): ArrayBuffer | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require('node:sea') as {
      getRawAsset: (k: string) => ArrayBuffer | undefined
    }
    return sea.getRawAsset(key) ?? null
  } catch {
    return null
  }
}

/** Serve the SPA from embedded SEA assets (single-executable deployment). */
function seaStatic() {
  return async (c: import('hono').Context<AppEnv>) => {
    const path = new URL(c.req.url).pathname
    // Route non-asset paths to the SPA entry.
    const asset =
      path === '/' || !path.includes('.') ? 'index.html' : path.slice(1)
    const data = getSeaAsset(asset)
    if (data === null) {
      // Fall back to index.html for client-side routing.
      const index = getSeaAsset('index.html')
      if (index === null) return c.json({ ok: false, error: 'not found' }, 404)
      return new Response(index, {
        headers: { 'content-type': 'text/html' },
      })
    }
    const ext = asset.slice(asset.lastIndexOf('.'))
    return new Response(data, {
      headers: {
        'content-type': MIME[ext] ?? 'application/octet-stream',
      },
    })
  }
}

async function main(): Promise<void> {
  const config = loadConfig()

  const dbRes = await connectDb(config.postgresUrl)
  if (dbRes.isErr()) {
    console.error(`[server] ${dbRes.error}`)
    process.exit(1)
  }
  const db: Db = dbRes.value

  const busRes = await connectBus(config.natsUrl)
  if (busRes.isErr()) {
    console.error(`[server] ${busRes.error} (event bus is required)`)
    process.exit(1)
  }
  const bus: Bus = busRes.value

  const llm = new LlmRegistry(config)
  const deps: AgentDeps = {
    db,
    sql: db.$client,
    bus,
    config,
    llm,
  }

  const app = new Hono<AppEnv>()

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      if (err.res) return c.newResponse(err.res.body, err.res)
      return c.json({ ok: false, error: err.message }, err.status)
    }
    console.error('[server] unhandled error:', err)
    return c.json({ ok: false, error: 'Internal Server Error' }, 500)
  })
  app.use('*', async (c, next) => {
    c.set('deps', deps)
    await next()
  })

  app.route('/api/v1', buildRoutes())

  // Serve the SPA from embedded SEA assets (single-executable deployment).
  app.use('*', seaStatic())

  // Watch every session's mailbox wake wildcard so this replica can claim and
  // run work for any session — the horizontal scale-out trigger.
  const stopWake = watchMailboxWake(deps)

  // Populate the models.dev catalog cache once at startup (30min TTL); a
  // failing fetch is non-fatal — the catalog is a prefill convenience.
  void refreshModelsDev(bus).then(
    () => {},
    e => console.warn(`[server] ${e}`),
  )

  const server = serve({ fetch: app.fetch, port: config.port }, info => {
    console.log(
      `[server] rucoder-agent-ts listening on :${info.port} (pid ${process.pid})`,
    )
  })

  const shutdown = () => {
    console.log('[server] shutting down')
    stopWake()
    server.close(() => {
      bus.close()
      void db.$client.end().then(
        () => process.exit(0),
        () => process.exit(0),
      )
      setTimeout(() => process.exit(0), 3000).unref()
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Recovery: re-run turns for sessions whose prompts were enqueued while no
  // replica was alive. The claim mechanism keeps this safe across replicas
  // (exactly one wins the per-session lease).
  const pending = await Mailbox.pendingSessions(db)
  if (pending.isOk()) {
    for (const sid of pending.value) {
      void runSessionTurn(deps, sid).then(
        () => {},
        e =>
          console.error(`[agent] recovery turn crashed (${sid}): ${String(e)}`),
      )
    }
  }
}

void main()
