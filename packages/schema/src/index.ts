import { z } from 'zod'

/**
 * Lightweight JSON-parse helper returning a `neverthrow` Result so the UI can
 * decode SSE payloads without try/catch or direct `JSON.parse`.
 */
export function parseLoose(
  raw: string | Uint8Array,
):
  | { isOk(): boolean; isErr(): boolean; value: unknown; error: string }
  | { match<T>(ok: (v: unknown) => T, err: (e: string) => T): T } {
  let value: unknown
  try {
    value = JSON.parse(
      raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : raw,
    )
  } catch (e) {
    return {
      isOk: () => false,
      isErr: () => true,
      value: null,
      error: String(e),
      match: (_ok, errFn) => errFn(String(e)),
    }
  }
  return {
    isOk: () => true,
    isErr: () => false,
    value,
    error: '',
    match: okFn => okFn(value),
  }
}

// ---- zod schemas (API contract, shared with server) ----------------

export const SessionRowSchema = z.object({
  name: z.string(),
  org: z.string(),
  repo: z.string(),
  branch: z.string(),
  model: z.string(),
  preset: z.string(),
  tip_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  fork_at_msg_id: z.string().nullable(),
  worker_url: z.string().nullable(),
  container_id: z.string().nullable(),
  max_turns: z.number().int().nullable(),
  system_prompt: z.string().nullable(),
  revert: z.string().nullable(),
  redo_tip_id: z.string().nullable(),
  last_read_at: z.string().nullable(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
  total_tokens: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  last_used_at: z.string().nullable(),
})
export type SessionRow = z.infer<typeof SessionRowSchema>

export const MessageRowSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string(),
  parts_json: z.string(),
  prev_id: z.string().nullable(),
  tool_name: z.string(),
  tool_call_id: z.string(),
  created_at: z.string(),
})
export type MessageRow = z.infer<typeof MessageRowSchema>

export const PartRowSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  type: z.string(),
  change_id: z.string().nullable(),
  seq: z.number().int(),
  data: z.string(),
})
export type PartRow = z.infer<typeof PartRowSchema>

export const MailboxRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  msg_type: z.string(),
  payload: z.string(),
  effective_at: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  consumed_at: z.string().nullable(),
  seq: z.number().int().nullable(),
})
export type MailboxRow = z.infer<typeof MailboxRowSchema>

export const PresetRowSchema = z.object({
  id: z.string(),
  system_prompt: z.string(),
  tools: z.string(),
  max_turns: z.number().int(),
})
export type PresetRow = z.infer<typeof PresetRowSchema>

export const ProviderRowSchema = z.object({
  provider_id: z.string(),
  api_type: z.string(),
  base_url: z.string(),
  api_key: z.string(),
  headers: z.string(),
  models: z.string(),
  updated_at: z.string(),
})
export type ProviderRow = z.infer<typeof ProviderRowSchema>

// ---- request bodies ----------------

export const CreateSessionBodySchema = z.object({
  name: z.string().min(1),
  org: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().min(1),
  model: z.string().optional(),
  preset: z.string().optional(),
})
export type CreateSessionBody = z.infer<typeof CreateSessionBodySchema>

export const PromptBodySchema = z.object({ prompt: z.string().min(1) })
export type PromptBody = z.infer<typeof PromptBodySchema>

export const ForkBodySchema = z.object({
  name: z.string().min(1),
  branch: z.string().optional(),
})
export type ForkBody = z.infer<typeof ForkBodySchema>

export const ModelBodySchema = z.object({ model: z.string().min(1) })
export type ModelBody = z.infer<typeof ModelBodySchema>

export const UndoBodySchema = z.object({ message_id: z.string().optional() })
export type UndoBody = z.infer<typeof UndoBodySchema>

export const SessionSettingsBodySchema = z.object({
  model: z.string().optional(),
  preset: z.string().optional(),
  max_turns: z.number().int().optional(),
  system_prompt: z.string().optional(),
})
export type SessionSettingsBody = z.infer<typeof SessionSettingsBodySchema>

export const PresetBodySchema = z.object({
  id: z.string().min(1),
  system_prompt: z.string().optional(),
  tools: z.unknown().optional(),
  max_turns: z.number().int().optional(),
})
export type PresetBody = z.infer<typeof PresetBodySchema>

export const ConfigBodySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
})
export type ConfigBody = z.infer<typeof ConfigBodySchema>

export const ProviderBodySchema = z.object({
  provider_id: z.string().min(1),
  api_type: z.string().min(1),
  base_url: z.string().url(),
  api_key: z.string().optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
  models: z.array(z.string()).optional(),
})
export type ProviderBody = z.infer<typeof ProviderBodySchema>

export const ProviderTestBodySchema = z.object({
  api_type: z.string(),
  base_url: z.string().url(),
  api_key: z.string().optional(),
})
export type ProviderTestBody = z.infer<typeof ProviderTestBodySchema>

// ---- SSE events ----------------

export const SSE_EVENT_NAMES = [
  'status',
  'text-delta',
  'tool-result',
  'error',
  'turn-complete',
] as const
export type SSEEventName = (typeof SSE_EVENT_NAMES)[number]

export interface SSEEnvelope {
  event: SSEEventName | string
  params: unknown
  /** Unique id injected by the publisher for replay/live dedup. */
  eid: string
}

// ---- API error envelope ----------------

export interface ApiErrorBody {
  ok: false
  error: string
}

// ---- typed API contract ----------------
//
// The UI builds a type-safe Hono client via `hc<AppRoutes>()` using this
// hand-written structural contract, so it does NOT depend on
// @rucoder-agent/server (only on @rucoder-agent/schema). The server's real
// router is type-checked against this contract via `satisfies`.

export type SessionJson = SessionRow & { base_image: null; unread: number }

export interface ProviderJson {
  provider_id: string
  api_type: string
  base_url: string
  api_key: string
  headers: Record<string, unknown>
  models: string[]
}

export interface AppRoutes {
  sessions: {
    $get: () => Promise<{ sessions: SessionJson[] }>
    $post: (input: { json: CreateSessionBody }) => Promise<{
      ok: boolean
      session_name: string
    }>
    ':id': {
      $get: () => Promise<{ session: SessionJson }>
      $delete: () => Promise<{ ok: boolean }>
      messages: {
        $get: () => Promise<{
          messages: Array<{
            id: string
            role: string
            content: string
            created_at: string
          }>
        }>
      }
      prompt: {
        $post: (input: { json: PromptBody }) => Promise<{ ok: boolean }>
      }
      interrupt: {
        $post: () => Promise<{ interrupted: boolean }>
      }
      fork: {
        $post: (input: { json: ForkBody }) => Promise<{
          ok: boolean
          session_name: string
        }>
      }
    }
  }
  providers: {
    $get: () => Promise<{ providers: Record<string, ProviderJson> }>
    $post: (input: { json: ProviderBody }) => Promise<{
      ok: boolean
      provider_id: string
    }>
    test: {
      $post: (input: {
        json: ProviderTestBody
      }) => Promise<{ ok: boolean; models?: unknown; error?: string }>
    }
  }
  models: {
    $get: () => Promise<{ models: string[] }>
  }
}
