import { err, ok, type Result } from 'neverthrow'
import { z } from 'zod'

/**
 * A single source of truth for JSON serialization/deserialization.
 *
 * Nothing in the codebase may call `JSON.parse` / `JSON.stringify` directly —
 * every boundary uses these helpers so malformed input is always reported via
 * `neverthrow` `Result` (parse) rather than throwing or silently nulling.
 */

export type Json = unknown

/** Parse raw text (or Uint8Array) into JSON with a shape-validating schema. */
export function parse<T extends z.ZodType>(
  schema: T,
  raw: string | Uint8Array | null | undefined,
): Result<z.infer<T>, string> {
  if (raw === null || raw === undefined) {
    return err('parse: input is null/undefined')
  }
  const text =
    raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : raw
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return err(`parse: invalid JSON: ${String(e)}`)
  }
  const result = schema.safeParse(data)
  if (result.success) return ok(result.data)
  return err(`parse: schema mismatch: ${z.treeifyError(result.error)}`)
}

/** Serialize a value to a JSON string. Never throws for JSON-safe input. */
export function stringify(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/** Bare JSON parse (no schema) returning a Result on malformed input. */
export function parseLoose(
  raw: string | Uint8Array | null | undefined,
): Result<Json, string> {
  if (raw === null || raw === undefined)
    return err('parse: input is null/undefined')
  const text =
    raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8') : raw
  try {
    return ok(JSON.parse(text))
  } catch (e) {
    return err(`parse: invalid JSON: ${String(e)}`)
  }
}

/** Legacy alias used by older call sites; prefer `parse(schema, …)`. */
export function parseJson<T = unknown>(
  raw: string | null | undefined,
): Result<T, string> {
  return parseLoose(raw).map(v => v as T)
}

// ---- shared payload / envelope schemas (kept here to avoid a schema→db dep) ----

export const WakePayloadSchema = z.object({
  session_id: z.string(),
  type: z.enum(['user_prompt', 'interrupt', 'event']),
})
export type WakePayload = z.infer<typeof WakePayloadSchema>

export const ContentPayloadSchema = z.object({
  content: z.string().optional(),
  text: z.string().optional(),
  prompt: z.string().optional(),
})
export type ContentPayload = z.infer<typeof ContentPayloadSchema>

export const ToolPartDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})
export type ToolPartData = z.infer<typeof ToolPartDataSchema>

export const ToolResultPartDataSchema = z.object({
  tool_use_id: z.string(),
  content: z.string(),
})
export type ToolResultPartData = z.infer<typeof ToolResultPartDataSchema>

export const TextPartDataSchema = z.object({
  text: z.string(),
})
export type TextPartData = z.infer<typeof TextPartDataSchema>
