import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import {
  Config,
  discoverTools,
  Presets,
  Providers,
  parse,
  renderTemplate,
} from '@rucoder-agent/agent'
import { ConfigBodySchema, PresetBodySchema } from '@rucoder-agent/schema'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { AppEnv } from '../context.js'

const ModelsArraySchema = z.array(z.string())
const HeadersRecordSchema = z.record(z.string(), z.unknown())

const ErrorSchema = z.object({ ok: z.boolean(), error: z.string() })

// ---- presets ----

const listPresetsRoute = createRoute({
  method: 'get',
  path: '/presets',
  summary: 'List presets',
  responses: {
    200: {
      description: 'Preset rows',
      content: {
        'application/json': {
          schema: z.array(
            z.object({
              id: z.string(),
              system_prompt: z.string(),
              tools: z.array(z.string()),
              max_turns: z.number(),
            }),
          ),
        },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const upsertPresetRoute = createRoute({
  method: 'post',
  path: '/presets',
  summary: 'Create or update a preset',
  request: {
    body: { content: { 'application/json': { schema: PresetBodySchema } } },
  },
  responses: {
    200: {
      description: 'Ok',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const deletePresetRoute = createRoute({
  method: 'delete',
  path: '/presets/{id}',
  summary: 'Delete a preset',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Ok',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const previewPresetRoute = createRoute({
  method: 'get',
  path: '/presets/{id}/preview',
  summary: 'Preview a preset system prompt with template variables rendered',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Rendered prompt',
      content: {
        'application/json': {
          schema: z.object({
            template: z.string(),
            rendered: z.string(),
          }),
        },
      },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

// ---- generic config ----

const getConfigRoute = createRoute({
  method: 'get',
  path: '/config',
  summary: 'Get providers config (compat)',
  responses: {
    200: {
      description: 'Providers',
      content: {
        'application/json': { schema: z.object({ providers: z.unknown() }) },
      },
    },
  },
})

const getConfigKeyRoute = createRoute({
  method: 'get',
  path: '/config/{key}',
  summary: 'Get a single config value',
  request: { params: z.object({ key: z.string() }) },
  responses: {
    200: {
      description: 'Config value',
      content: {
        'application/json': {
          schema: z.object({ key: z.string(), value: z.string() }),
        },
      },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const putConfigRoute = createRoute({
  method: 'put',
  path: '/config',
  summary: 'Set a config value',
  request: {
    body: { content: { 'application/json': { schema: ConfigBodySchema } } },
  },
  responses: {
    200: {
      description: 'Ok',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

// ---- tool config ----

const getToolConfigRoute = createRoute({
  method: 'get',
  path: '/tool-config',
  summary: 'Get tool config',
  responses: {
    200: {
      description: 'Tool config',
      content: { 'application/json': { schema: z.unknown() } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const putToolConfigRoute = createRoute({
  method: 'put',
  path: '/tool-config',
  summary: 'Set tool config',
  responses: {
    200: {
      description: 'Updated config',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean(), config: z.unknown() }),
        },
      },
    },
    400: {
      description: 'Bad request',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

// ---- tools ----

const listToolsRoute = createRoute({
  method: 'get',
  path: '/tools',
  summary: 'Discover tools',
  responses: {
    200: {
      description: 'Tools',
      content: {
        'application/json': {
          schema: z.object({
            tools: z.array(
              z.object({
                name: z.string(),
                description: z.string(),
                category: z.string(),
                parameters: z.record(z.string(), z.unknown()).nullable(),
                configFields: z.array(z.unknown()).nullable(),
              }),
            ),
          }),
        },
      },
    },
  },
})

// ---- models ----

const listModelsRoute = createRoute({
  method: 'get',
  path: '/models',
  summary: 'List available models',
  responses: {
    200: {
      description: 'Models',
      content: {
        'application/json': {
          schema: z.object({
            models: z.array(z.object({ id: z.string(), name: z.string() })),
          }),
        },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

// ---- recore config ----

const recoreConfigRoute = createRoute({
  method: 'get',
  path: '/recore-config',
  summary: 'Recore config',
  responses: {
    200: {
      description: 'Recore config',
      content: { 'application/json': { schema: z.unknown() } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

export const configRoutes = new OpenAPIHono<AppEnv>()
  .openapi(listPresetsRoute, async c => {
    const { db } = c.get('deps')
    const r = await Presets.list(db)
    if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
    return c.json(
      r.value.map(p => ({
        id: p.id,
        system_prompt: p.system_prompt,
        tools: parse(z.array(z.string()), p.tools).unwrapOr([]),
        max_turns: p.max_turns,
      })),
      200,
    )
  })
  .openapi(upsertPresetRoute, async c => {
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
      : c.json({ ok: true }, 200)
  })
  .openapi(deletePresetRoute, async c => {
    const { db } = c.get('deps')
    const r = await Presets.delete(db, c.req.valid('param').id)
    return r.isErr()
      ? c.json({ ok: false, error: r.error }, 500)
      : c.json({ ok: true }, 200)
  })
  .openapi(previewPresetRoute, async c => {
    const { db, bus } = c.get('deps')
    const id = c.req.valid('param').id
    const r = await Presets.get(db, id)
    if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
    if (r.value === null) {
      return c.json({ ok: false, error: 'preset not found' }, 404)
    }
    const template = r.value.system_prompt
    const rendered = await renderTemplate(template, bus)
    return c.json({ template, rendered }, 200)
  })
  .openapi(getConfigRoute, async c => {
    const { db } = c.get('deps')
    const r = await Config.get(db, 'providers')
    // Providers live in their own table now; expose them for UI compatibility.
    const providers =
      r.isOk() && r.value !== null
        ? parse(z.unknown(), r.value).unwrapOr({})
        : {}
    return c.json({ providers }, 200)
  })
  .openapi(getConfigKeyRoute, async c => {
    const { db } = c.get('deps')
    const { key } = c.req.valid('param')
    const r = await Config.get(db, key)
    if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
    return r.value === null
      ? c.json({ ok: false, error: 'config not found' }, 404)
      : c.json({ key, value: r.value }, 200)
  })
  .openapi(putConfigRoute, async c => {
    const { db } = c.get('deps')
    const b = c.req.valid('json')
    const r = await Config.set(db, b.key, b.value)
    return r.isErr()
      ? c.json({ ok: false, error: r.error }, 500)
      : c.json({ ok: true }, 200)
  })
  .openapi(getToolConfigRoute, async c => {
    const { db } = c.get('deps')
    const r = await Config.get(db, 'tool_config')
    if (r.isErr()) return c.json({ ok: false, error: r.error }, 500)
    const value =
      r.value === null ? {} : parse(z.unknown(), r.value).unwrapOr({})
    return c.json(value, 200)
  })
  .openapi(putToolConfigRoute, async c => {
    const { db } = c.get('deps')
    const body = await ResultAsync.fromPromise(c.req.json(), () => null)
    if (body.isErr() || body.value === null) {
      return c.json({ ok: false, error: 'invalid json body' }, 400)
    }
    const r = await Config.set(db, 'tool_config', JSON.stringify(body.value))
    return r.isErr()
      ? c.json({ ok: false, error: r.error }, 500)
      : c.json({ ok: true, config: body.value }, 200)
  })
  .openapi(listToolsRoute, async c => {
    const deps = c.get('deps')
    const tools = await discoverTools(deps.bus)
    return c.json(
      {
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          category: t.extId,
          parameters: t.inputSchema ?? null,
          configFields: null,
        })),
      },
      200,
    )
  })
  .openapi(listModelsRoute, async c => {
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
    return c.json({ models: models.map(id => ({ id, name: id })) }, 200)
  })
  .openapi(recoreConfigRoute, async c => {
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
    return c.json(
      {
        providers,
        cdp_url: process.env.RUCODER_CDP_URL ?? '',
        http_proxy: process.env.RUCODER_HTTP_PROXY ?? '',
        self_base: process.env.RUCODER_SELF_BASE ?? '',
      },
      200,
    )
  })
