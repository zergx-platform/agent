import { Agent as AbcAgent } from '@abc-protocol/sdk'
import {
  type ExtensionConfigItem,
  ExtensionManifestSchema,
  type ExtensionTool,
} from '@zergx-agent/schema'
import { jsonSchema, type Tool } from 'ai'
import { z } from 'zod'
import type { Bus } from './bus.js'
import { EXTENSION_DISCOVER_SUBJECT } from './extensions.js'
import { localizeSchema, pickDescription } from './i18n.js'
import { parse, type ToolResult } from './json.js'

export const ToolManifestSchema = z.object({
  name: z.string(),
  description: z.string(),
  descriptions: z.record(z.string(), z.string()).optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
})

export interface DiscoveredTool {
  /** Owning extension id — tool calls go to `tool.call.{extId}.{name}`. */
  extId: string
  name: string
  description: string
  /** Localized descriptions (locale → text); `description` is the fallback. */
  descriptions?: Record<string, string>
  /** JSON Schema object describing the tool's arguments. */
  inputSchema: Record<string, unknown>
  /** Declared config knobs of the owning extension (extension-level). */
  extConfig?: {
    name: string
    type: string
    enum_values?: string[]
    default?: unknown
    description?: string
    scope?: string
  }[]
}

/**
 * Wire-safe qualified name for a discovered tool: `name` when the name is
 * unique across extensions, `extId.name` when it collides. This is the exact
 * key used in the AI-tool set and in preset whitelists.
 */
export function toolQualifiedName(
  discovered: DiscoveredTool[],
  t: DiscoveredTool,
): string {
  return discovered.filter(d => d.name === t.name).length > 1
    ? `${t.extId}.${t.name}`
    : t.name
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
    const config = m.config as unknown as ExtensionConfigItem[]
    for (const t of m.tools ?? []) {
      out.push(withExtConfig(toolToDiscovered(m.id, t), config))
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
 * ZERGX_DISCOVERY_TTL_MS, disable with 0.
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
  const v = process.env.ZERGX_DISCOVERY_TTL_MS
  if (v === undefined) return 30_000
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? 30_000 : n
}

function toolToDiscovered(extId: string, t: ExtensionTool): DiscoveredTool {
  return {
    extId,
    name: t.name,
    description: t.description,
    ...(t.descriptions !== undefined ? { descriptions: t.descriptions } : {}),
    inputSchema: t.input_schema ?? { type: 'object', properties: {} },
  }
}

/**
 * Attach the owning extension's declared config knobs to every tool it
 * exports, so the UI can render the right editor (model picker, enum, …).
 * Config is extension-level, but the agent surfaces it per tool for the
 * configured-tool surface.
 */
function withExtConfig(
  t: DiscoveredTool,
  config?: ExtensionConfigItem[],
): DiscoveredTool {
  if (!config || config.length === 0) return t
  const extConfig = config.map(c => ({
    name: c.name,
    type: c.type,
    enum_values: c.enum_values ?? [],
    default: c.default,
    description: c.description,
    scope: c.scope,
  }))
  return {
    ...t,
    extConfig: extConfig as NonNullable<DiscoveredTool['extConfig']>,
  }
}

/**
 * Build the AI SDK tool set from discovered manifests. `sessionId`, when
 * given, rides the first-class `session_name` envelope field (carried by
 * AbcAgent.callTool) — it is NOT injected into tool arguments, so the model
 * can neither see nor forge it.
 */
export function buildAiTools(
  discovered: DiscoveredTool[],
  bus: Bus,
  timeoutMs: number,
  sessionId?: string,
  abortSignal?: AbortSignal,
  locale?: string,
): Record<string, Tool<Record<string, unknown>, ToolResult>> {
  const tools: Record<string, Tool<Record<string, unknown>, ToolResult>> = {}
  for (const t of discovered) {
    // Two extensions may expose the same bare tool name; the AI SDK tool set
    // is keyed by name, so a collision would silently drop one. Namespace the
    // AI-tool key by extension id while keeping the wire tool name intact.
    const aiName = toolQualifiedName(discovered, t)
    if (tools[aiName] !== undefined) continue
    const description = locale
      ? pickDescription(t.description, t.descriptions, locale)
      : t.description
    // Property-level i18n uses the same `descriptions` convention inside the
    // schema; resolve it for the locale and strip the non-standard keys.
    const inputSchema = locale
      ? localizeSchema(t.inputSchema, locale)
      : t.inputSchema
    tools[aiName] = {
      description,
      inputSchema: jsonSchema(inputSchema),
      execute: async (args, { toolCallId }) => {
        return await raceFinal(
          new AbcAgent(bus)
            .callTool(sessionId ?? '', t.extId, t.name, toolCallId, args ?? {})
            .then(r => ({
              content: r.content ?? '',
              metadata: r.data ?? null,
            })),
          timeoutMs,
          t.name,
          abortSignal,
        )
      },
    }
  }
  return tools
}

/**
 * Await a single terminal ToolResult against a wall-clock deadline. Resolves
 * to the result when it arrives first; on timeout (or a rejected call) it
 * resolves to an error-content ToolResult so a stuck tool call never hangs
 * the turn and never feeds a raw error to the model.
 */
async function raceFinal(
  p: Promise<ToolResult>,
  timeoutMs: number,
  name: string,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<ToolResult>(resolve => {
    timer = setTimeout(() => {
      resolve({ content: `tool '${name}' timed out`, metadata: null })
    }, timeoutMs)
  })
  // Interrupt (stop button) must also cancel an in-flight tool call, not just
  // the LLM stream: resolve early the moment the abort signal fires so a long
  // tool (e.g. sandbox-job-wait) cannot block the turn past an interrupt.
  const aborted = new Promise<ToolResult>(resolve => {
    const onAbort = () =>
      resolve({ content: `tool '${name}' interrupted`, metadata: null })
    if (abortSignal === undefined) return
    if (abortSignal.aborted) {
      onAbort()
      return
    }
    abortSignal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([p, deadline, aborted]).catch(e => ({
      content: `tool '${name}' failed: ${String(e)}`,
      metadata: null,
    }))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
