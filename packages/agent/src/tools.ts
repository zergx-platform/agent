import { jsonSchema, type Tool } from 'ai'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { Bus } from './bus.js'
import { toolCallSubject, toolResultSubject } from './bus.js'
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
const ToolListSchema = z.object({ tools: z.array(ToolManifestSchema) })

export interface DiscoveredTool {
  name: string
  description: string
  /** JSON Schema object describing the tool's arguments. */
  inputSchema: Record<string, unknown>
}

/**
 * Discover tools from all tool servers' manifest endpoints. A server that is
 * unreachable or returns an invalid manifest is skipped.
 */
export async function discoverTools(
  servers: string[],
): Promise<DiscoveredTool[]> {
  const out: DiscoveredTool[] = []
  for (const base of servers) {
    const url = `${base.replace(/\/$/, '')}/api/v1/tools`
    const result = await ResultAsync.fromPromise(
      fetch(url).then(r =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      ),
      () => null,
    )
    if (result.isErr()) continue
    const parsed = parse(ToolListSchema, JSON.stringify(result.value))
    if (parsed.isOk()) {
      for (const t of parsed.value.tools) {
        out.push({
          name: t.name,
          description: t.description,
          inputSchema: t.input_schema ?? { type: 'object', properties: {} },
        })
      }
    }
  }
  return out
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
        .publish(toolCallSubject(name), { call_id: callId, arguments: args })
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

/** Build the AI SDK tool set from discovered manifests. */
export function buildAiTools(
  discovered: DiscoveredTool[],
  bus: Bus,
  timeoutMs: number,
): Record<string, Tool<Record<string, unknown>, ToolResult>> {
  const tools: Record<string, Tool<Record<string, unknown>, ToolResult>> = {}
  for (const t of discovered) {
    tools[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      execute: async (args, { toolCallId }) => {
        const result = await invokeToolViaBus(
          bus,
          t.name,
          toolCallId,
          args ?? {},
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
