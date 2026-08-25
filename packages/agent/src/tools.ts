import {
  ExtensionManifestSchema,
  type ExtensionTool,
} from '@rucoder-agent/schema'
import { jsonSchema, type Tool } from 'ai'
import type { Subscription } from 'abep-sdk'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { Agent as AbepAgent } from 'abep-sdk'
import type { Bus } from './bus.js'
import { toolCallSubject, toolResultSubject } from './bus.js'
import { EXTENSION_DISCOVER_SUBJECT } from './extensions.js'
import {
  parse,
  type ToolResult,
  type ToolResultEnvelope,
  ToolResultEnvelopeSchema,
} from './json.js'

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
 * Invoke one tool over the NATS async request/reply contract: publish the
 * ToolCallEnvelope to `tool.call.{name}`, await the envelope (or Object
 * Store blob) on `tool.result.{call_id}`. Subscribe BEFORE publishing so an
 * instantly-answering tool server cannot race us.
 */
export function invokeToolViaBus(
  bus: Bus,
  extId: string,
  name: string,
  callId: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): ResultAsync<ToolResult, string> {
  return ResultAsync.fromPromise(
    (async () => {
      const sub = await bus.subscribe(toolResultSubject(callId))
      await bus.publish(
        toolCallSubject(extId, name),
        { call_id: callId, arguments: args },
        toolResultSubject(callId),
      )
      return sub
    })(),
    e => `tool '${name}': ${String(e)}`,
  ).andThen(sub =>
    ResultAsync.fromPromise(
      firstResult(sub, name, timeoutMs),
      e => `tool '${name}': ${String(e)}`,
    ).andThen(env => resolveContent(bus, env)),
  )
}

/**
 * Streamed tool invocation: subscribe to `tool.result.{call_id}` and yield a
 * ToolResult per envelope. Envelopes with `stream:"delta"` are progress
 * chunks (yielded as content, metadata null); the `stream:"final"` (or
 * legacy stream-less) envelope terminates the stream as the last yielded
 * value. The AI SDK turns each yield into a `preliminary` tool-result part
 * and the final one into the real result.
 */
export async function* invokeToolStreamViaBus(
  bus: Bus,
  extId: string,
  name: string,
  callId: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): AsyncGenerator<ToolResult> {
  let sub
  try {
    sub = await bus.subscribe(toolResultSubject(callId))
    await bus.publish(
      toolCallSubject(extId, name),
      { call_id: callId, arguments: args },
      toolResultSubject(callId),
    )
  } catch (e) {
    yield { content: `tool '${name}' failed: ${String(e)}`, metadata: null }
    return
  }

  let timedOut = false
  const deadline = setTimeout(() => {
    timedOut = true
    sub.close()
  }, timeoutMs)
  const finish = () => {
    clearTimeout(deadline)
    sub.close()
  }

  try {
    for await (const m of sub) {
      if (timedOut) break
      const parsed = parse(ToolResultEnvelopeSchema, JSON.stringify(m.payload))
      if (!parsed.isOk()) {
        continue
      }
      const env = parsed.value
      const resolved = await resolveContent(bus, env)
      if (resolved.isErr()) {
        yield {
          content: `tool '${name}' failed: ${resolved.error}`,
          metadata: null,
        }
        return
      }
      if (env.stream === 'final' || env.stream === undefined) {
        yield resolved.value
        return
      }
      // progress delta
      yield { content: resolved.value.content, metadata: null }
    }
    yield {
      content: timedOut
        ? `tool '${name}' timed out`
        : `tool '${name}' result stream closed`,
      metadata: null,
    }
  } finally {
    finish()
  }
}

function firstResult(
  sub: Subscription,
  name: string,
  timeoutMs: number,
): Promise<ToolResultEnvelope> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      sub.close()
      reject(new Error(`tool '${name}' timed out`))
    }, timeoutMs)
    void (async () => {
      try {
        for await (const m of sub) {
          if (settled) return
          const parsed = parse(ToolResultEnvelopeSchema, JSON.stringify(m.payload))
          if (parsed.isOk()) {
            settled = true
            clearTimeout(timer)
            sub.close()
            resolve(parsed.value)
            return
          }
        }
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error(`tool '${name}' result stream closed`))
        }
      } catch (err) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })()
  })
}

/**
 * Normalize an envelope into the canonical ToolResult. When a large payload
 * was offloaded to the Object Store (`content_object`), the full text is
 * fetched back; `metadata` is always forwarded from the envelope verbatim.
 */
function resolveContent(
  bus: Bus,
  env: ToolResultEnvelope,
): ResultAsync<ToolResult, string> {
  if (env.content_object !== undefined) {
    const agent = new AbepAgent(bus)
    return ResultAsync.fromPromise(
      agent.getObject(env.content_object),
      e => `object get: ${String(e)}`,
    ).map(bytes => ({
      content: bytes === null ? '' : Buffer.from(bytes).toString(),
      metadata: env.metadata,
    }))
  }
  return ResultAsync.fromSafePromise(
    Promise.resolve({ content: env.content, metadata: env.metadata }),
  )
}

/**
 * Build the AI SDK tool set from discovered manifests. When `sessionId` is
 * given, it is injected into every call as the out-of-band `_session`
 * argument: tool servers resolve it to their workspace context (repo +
 * bookmark). The argument is not part of any tool schema, so the model can
 * neither see nor forge it.
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
            const callArgs =
              sessionId === undefined
                ? (args ?? {})
                : { ...(args ?? {}), _session: sessionId }
            yield* invokeToolStreamViaBus(
              bus,
              t.extId,
              t.name,
              options.toolCallId,
              callArgs,
              timeoutMs,
            )
          } as never)
        : async (args, { toolCallId }) => {
            const callArgs =
              sessionId === undefined
                ? (args ?? {})
                : { ...(args ?? {}), _session: sessionId }
            const result = await invokeToolViaBus(
              bus,
              t.extId,
              t.name,
              toolCallId,
              callArgs,
              timeoutMs,
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
