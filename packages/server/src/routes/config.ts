import { zValidator } from '@hono/zod-validator'
import {
  Config,
  discoverTools,
  Presets,
  Providers,
  parse,
  parseLoose,
} from '@rucoder-agent/agent'
import { ConfigBodySchema, PresetBodySchema } from '@rucoder-agent/schema'
import { Hono } from 'hono'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { AppEnv } from '../context.js'

const ModelsArraySchema = z.array(z.string())
const HeadersRecordSchema = z.record(z.string(), z.unknown())

export const configRoutes = new Hono<AppEnv>()

// ---- presets ----

configRoutes.get('/presets', async c => {
  const { db } = c.get('deps')
  const r = await Presets.list(db)
  return r.isErr()
    ? c.json({ ok: false, error: r.error }, 500)
    : c.json(r.value)
})

configRoutes.post('/presets', zValidator('json', PresetBodySchema), async c => {
  const { db } = c.get('deps')
  const b = c.req.valid('json')
  const r = await Presets.upsert(db, {
    id: b.id,
    systemPrompt: b.system_prompt ?? '',
    tools: JSON.stringify(b.tools ?? []),
    maxTurns: b.max_turns ?? 0,
  })
  return r.isErr()
    ? c.json({ ok: false, error: r.error }, 500)
    : c.json({ ok: true })
})

configRoutes.delete('/presets/:id', async c => {
  const { db } = c.get('deps')
  const r = await Presets.delete(db, c.req.param('id'))
  return r.isErr()
    ? c.json({ ok: false, error: r.error }, 500)
    : c.json({ ok: true })
})

// ---- generic config ----

configRoutes.get('/config', async c => {
  const { db } = c.get('deps')
  const r = await Config.get(db, 'providers')
  // Providers live in their own table now; expose them for UI compatibility.
  const providers =
    r.isOk() && r.value !== null ? parseLoose(r.value).unwrapOr({}) : {}
  return c.json({ providers })
})

configRoutes.get('/config/:key', async c => {
  const { db } = c.get('deps')
  const r = await Config.get(db, c.req.param('key'))
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
  return r.value === null
    ? c.json({ ok: false, error: 'config not found' }, 404)
    : c.json({ key: c.req.param('key'), value: r.value })
})

configRoutes.put('/config', zValidator('json', ConfigBodySchema), async c => {
  const { db } = c.get('deps')
  const b = c.req.valid('json')
  const r = await Config.set(db, b.key, b.value)
  return r.isErr()
    ? c.json({ ok: false, error: r.error }, 500)
    : c.json({ ok: true })
})

// ---- tool config ----

configRoutes.get('/tool-config', async c => {
  const { db } = c.get('deps')
  const r = await Config.get(db, 'tool_config')
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
  const value = r.value === null ? {} : parseLoose(r.value).unwrapOr({})
  return c.json(value)
})

configRoutes.put('/tool-config', async c => {
  const { db } = c.get('deps')
  const body = await ResultAsync.fromPromise(c.req.json(), () => null)
  if (body.isErr() || body.value === null) {
    return c.json({ ok: false, error: 'invalid json body' }, 400)
  }
  const r = await Config.set(db, 'tool_config', JSON.stringify(body.value))
  return r.isErr()
    ? c.json({ ok: false, error: r.error }, 500)
    : c.json({ ok: true, config: body.value })
})

// ---- tools ----

configRoutes.get('/tools', async c => {
  const deps = c.get('deps')
  const tools = await discoverTools(deps.config.toolServers)
  return c.json({
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
    })),
  })
})

// ---- models ----

configRoutes.get('/models', async c => {
  const { db, llm } = c.get('deps')
  const r = await Providers.list(db)
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
  const models: string[] = []
  for (const p of r.value) {
    const arr = parse(ModelsArraySchema, p.models)
    if (arr.isOk()) models.push(...arr.value)
  }
  if (!models.includes(llm.defaultModelId()))
    models.unshift(llm.defaultModelId())
  return c.json({ models })
})

// ---- recore config ----

configRoutes.get('/recore-config', async c => {
  const deps = c.get('deps')
  const r = await Providers.list(deps.db)
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
  const providers: Record<string, unknown> = {}
  for (const p of r.value) {
    providers[p.provider_id] = {
      provider_id: p.provider_id,
      api_type: p.api_type,
      base_url: p.base_url,
      api_key: p.api_key,
      headers: parse(HeadersRecordSchema, p.headers).unwrapOr({}),
      models: parse(ModelsArraySchema, p.models).unwrapOr([]),
    }
  }
  return c.json({
    providers,
    cdp_url: process.env.RUCODER_CDP_URL ?? '',
    http_proxy: process.env.RUCODER_HTTP_PROXY ?? '',
    self_base: process.env.RUCODER_SELF_BASE ?? '',
  })
})
