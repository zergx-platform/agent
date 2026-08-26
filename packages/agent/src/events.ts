import { randomUUID } from 'node:crypto'
import type { Bus } from './bus.js'
import { sseSubject } from './bus.js'
import { logger } from './logger.js'

export interface AgentEventDeps {
  bus: Bus
}

/**
 * Publish one SSE event for a session onto the durable stream.
 * Every event carries a unique `eid` so replay/live consumers can dedup.
 */
export function pushEvent(
  bus: Bus,
  sid: string,
  event: string,
  params: unknown = {},
): void {
  void bus
    .inboxPublish(
      sseSubject(sid),
      { event, params, eid: randomUUID() },
      { id: randomUUID() },
    )
    .catch(err => {
      logger.warn({ sid, err: String(err) }, 'sse publish failed')
    })
}

export const events = {
  status: (type: string) => ({ event: 'status', params: { type } }),
  textDelta: (text: string) => ({ event: 'text-delta', params: { text } }),
  toolResult: (toolUseId: string, content: string) => ({
    event: 'tool-result',
    params: { tool_use_id: toolUseId, content },
  }),
  error: (message: string) => ({ event: 'error', params: { message } }),
  compacted: (reason: 'manual' | 'overflow') => ({
    event: 'compacted',
    params: { reason },
  }),
  turnComplete: (reason: string) => ({
    event: 'turn-complete',
    params: { reason },
  }),
}

/** Lifecycle event kinds published on `abep.session.lifecycle.{kind}`. */
export type LifecycleEvent = 'created' | 'forked' | 'renamed' | 'deleted'

/**
 * Trigger hook: after a session lifecycle action commits, notify the durable
 * stream so any service (e.g. repo-extension workspaces) can react.
 * Best-effort by design — consumers must tolerate missed events and converge
 * via their own reconciliation.
 */
export function publishLifecycle(
  bus: Bus,
  event: LifecycleEvent,
  payload: Record<string, unknown>,
): void {
  void bus
    .inboxPublish(
      `abep.session.lifecycle.${event}`,
      {
        kind: event,
        ...payload,
      },
      { id: randomUUID() },
    )
    .catch(err => {
      logger.warn({ event, err: String(err) }, 'lifecycle publish failed')
    })
}
