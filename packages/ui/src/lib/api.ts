import type {
  AppRoutes,
  CreateSessionBody,
  SessionJson,
} from '@rucoder-agent/schema'
import {
  CatalogProvidersSchema,
  ProviderJsonSchema,
  SessionRowSchema,
} from '@rucoder-agent/schema'
import { hc } from 'hono/client'
import { err, ok, type Result, ResultAsync } from 'neverthrow'
import { z } from 'zod'

/**
 * Type-safe Hono RPC client. Paths and request bodies are fully inferred from
 * `AppRoutes` (declared in @rucoder-agent/schema); every response body is
 * validated at runtime against the shared zod schemas (single source of truth).
 *
 * Every network call returns a `neverthrow` Result — no try/catch/throw.
 */

const origin =
  typeof window !== 'undefined' ? window.location.origin : 'http://localhost'

export const client = hc<AppRoutes>(`${origin}/api/v1`)

const sessionJsonSchema = SessionRowSchema.extend({
  base_image: z.null(),
  unread: z.number(),
})

export type Session = z.infer<typeof sessionJsonSchema>

function decode<T>(
  schema: z.ZodType<T>,
  data: unknown,
  label: string,
): Result<T, string> {
  const r = schema.safeParse(data)
  return r.success ? ok(r.data) : err(`${label}: ${z.treeifyError(r.error)}`)
}

function request<T>(
  op: () => Promise<Response>,
  schema: z.ZodType<T>,
  label: string,
): ResultAsync<T, string> {
  const parseBody = (res: Response): Promise<unknown> =>
    res.json().then(
      v => v,
      () => null,
    )

  const run = async (): Promise<Result<T, string>> => {
    const res = await op()
    const body: unknown = await parseBody(res)
    if (!res.ok) {
      const msg = z
        .object({ error: z.string().optional() })
        .parse(body ?? {}).error
      return err<T, string>(msg ?? `${label} failed (HTTP ${res.status})`)
    }
    return decode(schema, body, label)
  }

  return ResultAsync.fromPromise(
    run().then(r => (r.isOk() ? r.value : Promise.reject(new Error(r.error)))),
    e => `${label}: ${String(e)}`,
  )
}

export const api = {
  listSessions: () =>
    request(
      () => client.sessions.$get(),
      z.object({ sessions: z.array(sessionJsonSchema) }),
      'list sessions',
    ).map(r => r.sessions),

  createSession: (body: CreateSessionBody) =>
    request(
      () => client.sessions.$post({ json: body }),
      z.object({ ok: z.boolean(), session_name: z.string() }),
      'create session',
    ),

  listMessages: (sid: string) =>
    request(
      () => client.sessions[':id'].messages.$get({}, { param: { id: sid } }),
      z.object({
        messages: z.array(
          z.object({
            id: z.string(),
            role: z.string(),
            content: z.string(),
            created_at: z.string(),
          }),
        ),
      }),
      'list messages',
    ).map(r => r.messages),

  prompt: (sid: string, prompt: string) =>
    request(
      () =>
        client.sessions[':id'].prompt.$post(
          { json: { prompt } },
          { param: { id: sid } },
        ),
      z.object({ ok: z.boolean() }),
      'prompt',
    ),

  interrupt: (sid: string) =>
    request(
      () => client.sessions[':id'].interrupt.$post({}, { param: { id: sid } }),
      z.object({ interrupted: z.boolean() }),
      'interrupt',
    ),

  sessionsStreamUrl: (sid: string) =>
    `/api/v1/sessions/${encodeURIComponent(sid)}/stream`,

  listProviders: () =>
    request(
      () => client.providers.$get(),
      z.object({ providers: z.record(z.string(), ProviderJsonSchema) }),
      'list providers',
    ).map(r => r.providers),

  registerProvider: (p: {
    provider_id: string
    api_type: string
    base_url: string
    api_key?: string
    models?: string[]
  }) =>
    request(
      () => client.providers.$post({ json: p }),
      z.object({ ok: z.boolean(), provider_id: z.string() }),
      'register provider',
    ),

  deleteProvider: (pid: string) =>
    request(
      () => client.providers[':id'].$delete(undefined, { param: { id: pid } }),
      z
        .object({ deleted: z.boolean().optional() })
        .or(z.object({ ok: z.boolean() })),
      'delete provider',
    ),

  testProvider: (p: { api_type: string; base_url: string; api_key?: string }) =>
    request(
      () => client.providers.test.$post({ json: p }),
      z.object({
        ok: z.boolean(),
        models: z.unknown().optional(),
        error: z.string().optional(),
      }),
      'test provider',
    ),

  listModels: () =>
    request(
      () => client.models.$get(),
      z.object({ models: z.array(z.string()) }),
      'list models',
    ).map(r => r.models),

  setSessionModel: (sid: string, model: string) =>
    request(
      () =>
        client.sessions[':id'].model.$post(
          { json: { model } },
          { param: { id: sid } },
        ),
      z.object({ model: z.string() }),
      'set model',
    ),

  updateSettings: (sid: string, patch: { model?: string; preset?: string }) =>
    request(
      () =>
        client.sessions[':id'].settings.$patch(
          { json: patch },
          { param: { id: sid } },
        ),
      z.object({ session: sessionJsonSchema }),
      'update settings',
    ),

  listPresets: () =>
    request(
      () => client.presets.$get(),
      z.array(
        z.object({
          id: z.string(),
          system_prompt: z.string(),
          tools: z.string(),
          max_turns: z.number(),
        }),
      ),
      'list presets',
    ),

  upsertPreset: (p: {
    id: string
    system_prompt?: string
    tools?: unknown
    max_turns?: number
  }) =>
    request(
      () => client.presets.$post({ json: p }),
      z.object({ ok: z.boolean() }),
      'upsert preset',
    ),

  deletePreset: (id: string) =>
    request(
      () => client.presets[':id'].$delete(undefined, { param: { id } }),
      z.object({ ok: z.boolean() }),
      'delete preset',
    ),

  listMailbox: (sid: string) =>
    request(
      () => client.sessions[':id'].mailbox.$get({}, { param: { id: sid } }),
      z.object({ entries: z.array(z.unknown()) }),
      'list mailbox',
    ).map(r => r.entries),

  fork: (sid: string, name: string) =>
    request(
      () =>
        client.sessions[':id'].fork.$post(
          { json: { name } },
          { param: { id: sid } },
        ),
      z.object({ ok: z.boolean(), session_name: z.string() }),
      'fork',
    ),

  rename: (sid: string, name: string) =>
    request(
      () =>
        client.sessions[':id'].rename.$post(
          { json: { name } },
          { param: { id: sid } },
        ),
      z.object({ ok: z.boolean(), session_name: z.string() }),
      'rename',
    ),

  undo: (sid: string) =>
    request(
      () => client.sessions[':id'].undo.$post({}, { param: { id: sid } }),
      z.object({ ok: z.boolean(), undone: z.boolean() }),
      'undo',
    ),

  catalogProviders: () =>
    request(
      () => client.providers.catalog.$get(),
      z.object({ catalog: CatalogProvidersSchema }),
      'catalog providers',
    ).map(r => r.catalog),
}

export type { SessionJson }
