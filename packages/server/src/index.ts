import { relative } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { type AgentDeps, runSessionTurn } from '@rucoder-agent/lib-agent'
import { type Bus, connectBus } from '@rucoder-agent/lib-bus'
import { loadConfig } from '@rucoder-agent/lib-config'
import { connectDb, type Db, Mailbox } from '@rucoder-agent/lib-db'
import { LlmRegistry } from '@rucoder-agent/lib-llm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Sql } from 'postgres'
import type { AppEnv } from './context.js'
import { buildRoutes } from './routes/index.js'

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
    sql: db.$client as Sql,
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

  // Static SPA fallback: default to the in-repo ./packages/ui/dist when the
  // frontend ships alongside the server image; RUCODER_WEB_DIST overrides.
  const webDist =
    config.webDist !== ''
      ? config.webDist
      : relative(process.cwd(), 'packages/ui/dist')
  app.use(
    '*',
    serveStatic({
      root: webDist,
      rewriteRequestPath: p =>
        p === '/' || !p.includes('.') ? '/index.html' : p,
    }),
  )

  const server = serve({ fetch: app.fetch, port: config.port }, info => {
    console.log(
      `[server] rucoder-agent-ts listening on :${info.port} (pid ${process.pid})`,
    )
  })

  const shutdown = () => {
    console.log('[server] shutting down')
    server.close(() => {
      bus.close()
      void (db.$client as Sql).end().catch(() => process.exit(0))
      setTimeout(() => process.exit(0), 3000).unref()
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Recovery: re-run turns for sessions whose prompts were enqueued while no
  // replica was alive. The advisory lock keeps this safe across replicas.
  const pending = await Mailbox.pendingSessions(db)
  if (pending.isOk()) {
    for (const sid of pending.value) {
      void runSessionTurn(deps, sid).catch(e =>
        console.error(`[agent] recovery turn crashed (${sid}): ${String(e)}`),
      )
    }
  }
}

void main()
