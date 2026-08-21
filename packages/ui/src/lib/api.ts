import type {
  AppRoutes,
  CreateSessionBody,
  ProviderJson,
  SessionJson,
} from '@rucoder-agent/schema'
import { SessionRowSchema } from '@rucoder-agent/schema'
import { hc } from 'hono/client'
import { err, ok, type Result, ResultAsync } from 'neverthrow'
import { z } from 'zod'

/**
 * Type-safe Hono RPC client. Paths and request bodies are fully inferred from
 * `AppRoutes` (declared in @rucoder-agent/schema), so the UI never imports the
 * server package and all responses are validated with zod before use.
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
  return ResultAsync.fromPromise(
    (async () => {
      const res = await op()
      const body: unknown = await parseBody(res)
      if (!res.ok) {
        const msg = (body as { error?: string } | null)?.error
        return err<T, string>(msg ?? `${label} failed (HTTP ${res.status})`)
      }
      const decoded = decode(schema, body, label)
      return decoded.isErr() ? err<T, string>(decoded.error) : ok(decoded.value)
    })().andThen(r => r),
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
      z.object({ providers: z.record(z.string(), z.unknown()) }),
      'list providers',
    ).map(r => r.providers as Record<string, ProviderJson>),

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
}

export type { SessionJson }
