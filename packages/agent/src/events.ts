import { randomUUID } from 'node:crypto'
import type { Bus } from './bus.js'
import { sseSubject } from './bus.js'

export interface AgentEventDeps {
  bus: Bus
}

/**
 * Publish one SSE event for a session onto the durable JetStream subject.
 * Every event carries a unique `eid` so replay/live consumers can dedup.
 */
export function pushEvent(
  bus: Bus,
  sid: string,
  event: string,
  params: unknown = {},
): void {
  bus
    .publishStream(sseSubject(sid), { event, params, eid: randomUUID() })
    .mapErr(err => {
      console.warn(`[agent] sse publish failed (${sid}): ${err}`)
      return err
    })
    .then(() => undefined)
}

export const events = {
  status: (type: string) => ({ event: 'status', params: { type } }),
  textDelta: (text: string) => ({ event: 'text-delta', params: { text } }),
  toolResult: (toolUseId: string, content: string) => ({
    event: 'tool-result',
    params: { tool_use_id: toolUseId, content },
  }),
  error: (message: string) => ({ event: 'error', params: { message } }),
  turnComplete: (reason: string) => ({
    event: 'turn-complete',
    params: { reason },
  }),
}
