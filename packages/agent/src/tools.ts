import {
  ExtensionManifestSchema,
  type ExtensionTool,
} from '@rucoder-agent/schema'
import { jsonSchema, type Tool } from 'ai'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
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
  name: string
  description: string
  /** JSON Schema object describing the tool's arguments. */
  inputSchema: Record<string, unknown>
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
    .requestMany(EXTENSION_DISCOVER_SUBJECT, {}, maxWaitMs)
    .unwrapOr([])
  const out: DiscoveredTool[] = []
  for (const bytes of replies) {
    const parsed = parse(ExtensionManifestSchema, bytes)
    if (parsed.isErr()) continue
    const m = parsed.value
    if (!m.capabilities.includes('tools')) continue
    for (const t of m.tools ?? []) {
      out.push(toolToDiscovered(t))
    }
  }
  return out
}

function toolToDiscovered(t: ExtensionTool): DiscoveredTool {
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema ?? { type: 'object', properties: {} },
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
  name: string,
  callId: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): ResultAsync<ToolResult, string> {
  return bus
    .subscribe(toolResultSubject(callId))
    .andThen(sub =>
      bus
        .publish(
          toolCallSubject(name),
          { call_id: callId, arguments: args },
          // Reply subject: extension SDKs answer via msg.Respond, so the
          // result lands on tool.result.{call_id} — the subject we hold.
          toolResultSubject(callId),
        )
        .map(() => sub),
    )
    .andThen(sub =>
      ResultAsync.fromPromise(
        Promise.race([firstResult(sub, name), timeout(name, timeoutMs)]),
        e => `tool '${name}': ${String(e)}`,
      ).andThen(env => resolveContent(bus, env)),
    )
}

function firstResult(
  sub: AsyncIterable<{ data: Uint8Array }>,
  name: string,
): Promise<ToolResultEnvelope> {
  return new Promise((resolve, reject) => {
    void (async () => {
      for await (const m of sub) {
        const parsed = parse(ToolResultEnvelopeSchema, m.data)
        if (parsed.isOk()) {
          resolve(parsed.value)
          return
        }
      }
      reject(new Error(`tool '${name}' result stream closed`))
    })()
  })
}

function timeout(name: string, timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`tool '${name}' timed out`)), timeoutMs)
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
    return bus
      .getObject(env.content_object)
      .map(bytes => ({ content: bytes.toString(), metadata: env.metadata }))
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
    tools[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      execute: async (args, { toolCallId }) => {
        const callArgs =
          sessionId === undefined
            ? (args ?? {})
            : { ...(args ?? {}), _session: sessionId }
        const result = await invokeToolViaBus(
          bus,
          t.name,
          toolCallId,
          callArgs,
          timeoutMs,
        )
        return result.match(
          output => output,
          e => ({ content: `tool '${t.name}' failed: ${e}`, metadata: null }),
        )
      },
    }
  }
  return tools
}
