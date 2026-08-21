import { z } from 'zod'

const SessionSchema = z.object({
  id: z.string(),
  org: z.string(),
  repo: z.string(),
  branch: z.string(),
  model: z.string(),
  preset: z.string(),
  max_turns: z.number().int().nullable(),
  system_prompt: z.string().nullable(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  total_tokens: z.number().int(),
  updated_at: z.string(),
})

export type Session = z.infer<typeof SessionSchema>

const ProviderSchema = z.object({
  provider_id: z.string(),
  api_type: z.string(),
  base_url: z.string(),
  api_key: z.string(),
  headers: z.record(z.string(), z.unknown()).optional(),
  models: z.array(z.string()).optional(),
})

export type Provider = z.infer<typeof ProviderSchema>

const MessageSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string(),
  created_at: z.string(),
})

export type ApiMessage = z.infer<typeof MessageSchema>

export type ChatEvent = {
  event: string
  params: {
    type?: string
    text?: string
    content?: string
    message?: string
    reason?: string
    tool_use_id?: string
  }
}

async function json<T>(
  res: Response,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `${label} failed (HTTP ${res.status})`)
  }
  return schema.parse(await res.json())
}

const base = '/api/v1'

export const api = {
  listSessions: () =>
    fetch(`${base}/sessions`)
      .then(r =>
        json(r, z.object({ sessions: z.array(SessionSchema) }), 'list'),
      )
      .then(d => d.sessions),

  createSession: (body: { org: string; repo: string; branch: string }) =>
    fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r =>
      json(r, z.object({ ok: z.boolean(), session_id: z.string() }), 'create'),
    ),

  listMessages: (sid: string) =>
    fetch(`${base}/sessions/${sid}/messages`).then(r =>
      json(r, z.object({ messages: z.array(MessageSchema) }), 'messages'),
    ),

  prompt: (sid: string, prompt: string) =>
    fetch(`${base}/sessions/${sid}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
    }),

  interrupt: (sid: string) =>
    fetch(`${base}/sessions/${sid}/interrupt`, { method: 'POST' }),

  sessionsStreamUrl: (sid: string) =>
    `${base}/sessions/${encodeURIComponent(sid)}/stream`,

  listProviders: () =>
    fetch(`${base}/providers`).then(r =>
      json(
        r,
        z.object({ providers: z.record(z.string(), ProviderSchema) }),
        'providers',
      ),
    ),

  registerProvider: (p: {
    provider_id: string
    api_type: string
    base_url: string
    api_key?: string
    models?: string[]
  }) =>
    fetch(`${base}/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p),
    }),

  deleteProvider: (pid: string) =>
    fetch(`${base}/providers/${encodeURIComponent(pid)}`, { method: 'DELETE' }),

  testProvider: (p: { api_type: string; base_url: string; api_key?: string }) =>
    fetch(`${base}/providers/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(p),
    }).then(r =>
      json(
        r,
        z.object({
          ok: z.boolean(),
          models: z.unknown().optional(),
          error: z.string().optional(),
        }),
        'test',
      ),
    ),

  listModels: () =>
    fetch(`${base}/models`).then(r =>
      json(r, z.object({ models: z.array(z.string()) }), 'models'),
    ),
}

export type { Session as SessionInfo }
