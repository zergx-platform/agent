import { jsonSchema, type Tool } from 'ai'
import type { Bus, ToolResultEnvelope } from './bus.js'
import { toolCallSubject, toolResultSubject } from './bus.js'
import { parseLoose } from './db-client.js'

export interface SessionCtx {
  org: string
  repo: string
  branch: string
}

export interface DiscoveredTool {
  name: string
  description: string
  /** JSON Schema object describing the tool's arguments. */
  inputSchema: Record<string, unknown>
}

/** Inject `_org`/`_repo`/`_branch`, preserving LLM-supplied values. */
export function injectSessionCtx(
  args: Record<string, unknown>,
  ctx: SessionCtx,
): Record<string, unknown> {
  return {
    _org: ctx.org,
    _repo: ctx.repo,
    _branch: ctx.branch,
    ...args,
  }
}

/** Discover tools from all tool servers' manifest endpoints. */
export async function discoverTools(
  servers: string[],
): Promise<DiscoveredTool[]> {
  const out: DiscoveredTool[] = []
  for (const base of servers) {
    const url = `${base.replace(/\/$/, '')}/api/v1/tools`
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const body = (await res.json()) as { tools?: DiscoveredTool[] }
      for (const t of body.tools ?? []) {
        if (typeof t.name === 'string' && typeof t.description === 'string') {
          out.push({
            name: t.name,
            description: t.description,
            inputSchema:
              t.inputSchema && typeof t.inputSchema === 'object'
                ? t.inputSchema
                : { type: 'object', properties: {} },
          })
        }
      }
    } catch {
      // tool server unreachable: skip it
    }
  }
  return out
}

export interface ToolBridgeOutput {
  content: string
  result?: unknown
}

/**
 * Invoke one tool over the NATS async request/reply contract: publish the
 * ToolCallEnvelope to `tool.call.{name}`, await the envelope (or Object
 * Store blob) on `tool.result.{call_id}`. Subscribe BEFORE publishing so an
 * instantly-answering tool server cannot race us.
 */
export async function invokeToolViaBus(
  bus: Bus,
  name: string,
  callId: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<ToolBridgeOutput> {
  const subRes = await bus.subscribe(toolResultSubject(callId))
  if (subRes.isErr()) throw new Error(subRes.error)
  const sub = subRes.value

  const pubRes = await bus.publish(toolCallSubject(name), {
    call_id: callId,
    arguments: args,
  })
  if (pubRes.isErr()) {
    sub.unsubscribe()
    throw new Error(pubRes.error)
  }

  const first = (async (): Promise<ToolResultEnvelope> => {
    for await (const m of sub) {
      const parsed = parseLoose(Buffer.from(m.data))
      if (parsed.isOk()) return parsed.value as ToolResultEnvelope
    }
    throw new Error(`tool '${name}' result stream closed`)
  })()

  let handle: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<never>((_, reject) => {
    handle = setTimeout(() => {
      reject(new Error(`tool '${name}' timed out`))
    }, timeoutMs)
  })

  try {
    const env = await Promise.race([first, timer])
    if (env.content_object !== undefined && env.content_object !== null) {
      const blob = await bus.getObject(env.content_object)
      return { content: blob.toString(), result: env.result }
    }
    return { content: env.content ?? '', result: env.result }
  } catch (e) {
    first.catch(() => {}) // losing the race: swallow the loser's rejection
    throw e
  } finally {
    if (handle !== undefined) clearTimeout(handle)
    sub.unsubscribe()
  }
}

/** Build the AI SDK tool set from discovered manifests. */
export function buildAiTools(
  discovered: DiscoveredTool[],
  ctx: SessionCtx,
  bus: Bus,
  timeoutMs: number,
): Record<string, Tool> {
  const tools: Record<string, Tool> = {}
  for (const t of discovered) {
    tools[t.name] = {
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as never),
      execute: async (args: Record<string, unknown>, { toolCallId }) => {
        const merged = injectSessionCtx(args ?? {}, ctx)
        try {
          return await invokeToolViaBus(
            bus,
            t.name,
            toolCallId,
            merged,
            timeoutMs,
          )
        } catch (e) {
          return { content: `tool '${t.name}' failed: ${String(e)}` }
        }
      },
    }
  }
  return tools
}
