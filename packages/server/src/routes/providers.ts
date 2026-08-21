import { zValidator } from '@hono/zod-validator'
import { Providers } from '@rucoder-agent/lib-db'
import { validateApiType } from '@rucoder-agent/lib-llm'
import {
  ProviderBodySchema,
  ProviderTestBodySchema,
} from '@rucoder-agent/schema'
import { Hono } from 'hono'
import type { AppEnv } from '../context.js'

function providerToJson(p: {
  provider_id: string
  api_type: string
  base_url: string
  api_key: string
  headers: string
  models: string
}): Record<string, unknown> {
  return {
    provider_id: p.provider_id,
    api_type: p.api_type,
    base_url: p.base_url,
    api_key: p.api_key,
    headers: JSON.parse(p.headers),
    models: JSON.parse(p.models),
  }
}

export const providerRoutes = new Hono<AppEnv>()

providerRoutes.get('/', async c => {
  const { db } = c.get('deps')
  const r = await Providers.list(db)
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
  const providers: Record<string, unknown> = {}
  for (const p of r.value) providers[p.provider_id] = providerToJson(p)
  return c.json({ providers })
})

providerRoutes.post('/', zValidator('json', ProviderBodySchema), async c => {
  const deps = c.get('deps')
  const b = c.req.valid('json')

  const valid = validateApiType(b.api_type)
  if (valid.isErr()) return c.json({ ok: false, error: valid.error }, 400)
  if (!b.base_url.startsWith('http://') && !b.base_url.startsWith('https://')) {
    return c.json({ ok: false, error: 'base_url must be http(s)' }, 400)
  }

  const r = await Providers.upsert(deps.db, {
    providerId: b.provider_id,
    apiType: b.api_type,
    baseUrl: b.base_url,
    apiKey: b.api_key ?? '',
    headers: b.headers ?? null,
    models: b.models ?? [],
  })
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
  deps.llm.invalidate()
  return c.json({ ok: true, provider_id: b.provider_id })
})

providerRoutes.delete('/:id', async c => {
  const deps = c.get('deps')
  const r = await Providers.delete(deps.db, c.req.param('id'))
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
  deps.llm.invalidate()
  return c.json({ deleted: true })
})

providerRoutes.post(
  '/test',
  zValidator('json', ProviderTestBodySchema),
  async c => {
    c.get('deps')
    const b = c.req.valid('json')
    const url = `${b.base_url.replace(/\/$/, '')}/models`
    try {
      const res = await fetch(url, {
        headers:
          b.api_key !== undefined && b.api_key !== ''
            ? { authorization: `Bearer ${b.api_key}` }
            : {},
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        return c.json({ ok: false, error: `HTTP ${res.status}` })
      }
      const body = (await res.json()) as { data?: unknown[] }
      return c.json({ ok: true, models: body.data ?? null })
    } catch (e) {
      return c.json({ ok: false, error: String(e) })
    }
  },
)
