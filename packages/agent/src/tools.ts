import {
  ExtensionManifestSchema,
  type ExtensionTool,
} from '@rucoder-agent/schema'
import {
  Agent as AbepAgent,
  type ToolResult as AbepToolResult,
} from 'abep-sdk'
import { jsonSchema, type Tool } from 'ai'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { Bus } from './bus.js'
import { EXTENSION_DISCOVER_SUBJECT } from './extensions.js'
import { parse, type ToolResult } from './json.js'

export const ToolManifestSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
})

export interface DiscoveredTool {
  /** Owning extension id — tool calls go to `tool.call.{extId}.{name}`. */
  extId: string
  name: string
  description: string
  /** JSON Schema object describing the tool's arguments. */
  inputSchema: Record<string, unknown>
  /** Whether the tool emits progress deltas before its final result. */
  streaming: boolean
}

/**
 * Discover tools from all extensions via a NATS broadcast. Every extension
 * that declares `tools` capability contributes its tool manifests; a reply
 * that fails validation is skipped.
 */
export async function discoverTools(
  bus: Bus,
  maxWaitMs = 500,
): Promise<DiscoveredTool[]> {
  const replies = await bus
    .requestMany(EXTENSION_DISCOVER_SUBJECT, {}, { maxWaitMs })
    .catch(() => [])
  const out: DiscoveredTool[] = []
  for (const env of replies) {
    const parsed = parse(ExtensionManifestSchema, JSON.stringify(env.payload))
    if (parsed.isErr()) continue
    const m = parsed.value
    if (!m.capabilities.includes('tools')) continue
    for (const t of m.tools ?? []) {
      out.push(toolToDiscovered(m.id, t))
    }
  }
  return out
}

// ---- cached discovery (the per-turn hot path) ----

interface DiscoveryCache {
  tools: DiscoveredTool[]
  expiresAt: number
  inFlight: Promise<DiscoveredTool[]> | null
}

const discoveryCache: DiscoveryCache = {
  tools: [],
  expiresAt: 0,
  inFlight: null,
}

/**
 * discoverTools with a TTL cache: every turn would otherwise pay the full
 * broadcast wait (~500ms) before the model even starts. Concurrent turns
 * share one in-flight broadcast (no thundering herd). Extensions restarted
 * with a changed toolset surface within one TTL; tune via
 * RUCODER_DISCOVERY_TTL_MS, disable with 0.
 */
export async function discoverToolsCached(
  bus: Bus,
  ttlMs = discoveryTtlMs(),
): Promise<DiscoveredTool[]> {
  if (ttlMs <= 0) return discoverTools(bus)
  const now = Date.now()
  if (discoveryCache.expiresAt > now) return discoveryCache.tools
  if (discoveryCache.inFlight !== null) return discoveryCache.inFlight

  discoveryCache.inFlight = discoverTools(bus).then(tools => {
    discoveryCache.tools = tools
    discoveryCache.expiresAt = Date.now() + ttlMs
    discoveryCache.inFlight = null
    return tools
  })
  return discoveryCache.inFlight
}

/** Drop the cached discovery result (e.g. after config changes). */
export function invalidateDiscoveryCache(): void {
  discoveryCache.tools = []
  discoveryCache.expiresAt = 0
}

function discoveryTtlMs(): number {
  const v = process.env.RUCODER_DISCOVERY_TTL_MS
  if (v === undefined) return 30_000
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? 30_000 : n
}

function toolToDiscovered(extId: string, t: ExtensionTool): DiscoveredTool {
  return {
    extId,
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema ?? { type: 'object', properties: {} },
    streaming: t.streaming === true,
  }
}

/**
 * Invoke one tool over the abep async request/reply contract via the SDK's
 * Agent.callTool (correct `abep.tool.call.*` / `abep.tool.result.*` subjects
 * and a first-class `session_name` envelope field). Returns the terminal
 * ToolResult or a neverthrow error.
 */
export function invokeToolViaBus(
  bus: Bus,
  extId: string,
  name: string,
  callId: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  sessionName?: string,
): ResultAsync<ToolResult, string> {
  return ResultAsync.fromPromise(
    collectFinal(new AbepAgent(bus).callTool(
      sessionName ?? '',
      extId,
      name,
      callId,
      args,
      () => {},
    ), name, timeoutMs),
    e => `tool '${name}': ${String(e)}`,
  )
}

/**
 * Streamed tool invocation via the SDK's Agent.callTool: progress deltas are
 * yielded as ToolResults (metadata null), then the terminal result. The AI
 * SDK turns each yield into a `preliminary` tool-result part and the final
 * one into the real result.
 */
export async function* invokeToolStreamViaBus(
  bus: Bus,
  extId: string,
  name: string,
  callId: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  sessionName?: string,
): AsyncGenerator<ToolResult> {
  let it: AsyncGenerator<AbepToolResult> | null = null
  try {
    it = new AbepAgent(bus).callTool(
      sessionName ?? '',
      extId,
      name,
      callId,
      args,
      () => {},
    )
  } catch (e) {
    yield { content: `tool '${name}' failed: ${String(e)}`, metadata: null }
    return
  }

  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
  }, timeoutMs)
  try {
    let done = false
    while (!done && !timedOut) {
      const raced = await raceTimeout(
        it.next(),
        timeoutMs,
      )
      if (raced === 'timeout') {
        timedOut = true
        break
      }
      if (raced.kind === 'throw') {
        throw raced.e
      }
      if (raced.r.done === true) break
      const value = raced.r.value
      const isFinal = value.stream === 'final'
      const metadata = value.metadata ?? null
      yield { content: value.content, metadata: isFinal ? metadata : null }
      if (isFinal) {
        done = true
      }
    }
    if (!done) {
      yield {
        content: timedOut
          ? `tool '${name}' timed out`
          : `tool '${name}' result stream closed`,
        metadata: null,
      }
      done = true
    }
  } catch (e) {
    yield { content: `tool '${name}' failed: ${String(e)}`, metadata: null }
  } finally {
    clearTimeout(deadline)
  }
}

/** Await an Agent.callTool stream until its terminal ToolResult. */
async function collectFinal(
  stream: AsyncGenerator<AbepToolResult>,
  name: string,
  timeoutMs: number,
): Promise<ToolResult> {
  let last: AbepToolResult | null = null
  const deadline = setTimeout(() => {
    throw new Error(`tool '${name}' timed out`)
  }, timeoutMs)
  try {
    for await (const r of stream) {
      last = r
    }
    if (last === null) {
      throw new Error(`tool '${name}' result stream closed`)
    }
    return { content: last.content, metadata: last.metadata ?? null }
  } finally {
    clearTimeout(deadline)
  }
}

type Iteration<T> = { kind: 'next'; r: IteratorResult<T> } | { kind: 'throw'; e: unknown }

function raceTimeout<T>(
  p: Promise<IteratorResult<T>>,
  timeoutMs: number,
): Promise<Iteration<T> | 'timeout'> {
  return Promise.race([
    p.then(
      r => ({ kind: 'next' as const, r }),
      e => ({ kind: 'throw' as const, e }),
    ),
    new Promise<'timeout'>(resolve => {
      setTimeout(() => resolve('timeout'), timeoutMs)
    }),
  ])
}

/**
 * Build the AI SDK tool set from discovered manifests. `sessionId`, when
 * given, rides the first-class `session_name` envelope field (carried by
 * AbepAgent.callTool) — it is NOT injected into tool arguments, so the model
 * can neither see nor forge it.
 */
export function buildAiTools(
  discovered: DiscoveredTool[],
  bus: Bus,
  timeoutMs: number,
  sessionId?: string,
): Record<string, Tool<Record<string, unknown>, ToolResult>> {
  const tools: Record<string, Tool<Record<string, unknown>, ToolResult>> = {}
  for (const t of discovered) {
    // Two extensions may expose the same bare tool name; the AI SDK tool set
    // is keyed by name, so a collision would silently drop one. Namespace the
    // AI-tool key by extension id while keeping the wire tool name intact.
    const aiName =
      discovered.filter(d => d.name === t.name).length > 1
        ? `${t.extId}.${t.name}`
        : t.name
    if (tools[aiName] !== undefined) continue
    tools[aiName] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      execute: t.streaming
        ? (async function* (
            args: Record<string, unknown>,
            options: { toolCallId: string },
          ) {
            yield* invokeToolStreamViaBus(
              bus,
              t.extId,
              t.name,
              options.toolCallId,
              args ?? {},
              timeoutMs,
              sessionId,
            )
          } as never)
        : async (args, { toolCallId }) => {
            const result = await invokeToolViaBus(
              bus,
              t.extId,
              t.name,
              toolCallId,
              args ?? {},
              timeoutMs,
              sessionId,
            )
            return result.match(
              output => output,
              e => ({
                content: `tool '${t.name}' failed: ${e}`,
                metadata: null,
              }),
            )
          },
    }
  }
  return tools
}
