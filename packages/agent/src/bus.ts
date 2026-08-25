import { Agent as AbepAgent } from 'abep-sdk'
import type { Bus as AbepBus } from 'abep-sdk'
import type { Envelope as AbepEnvelope, InboxMsg as AbepInboxMsg, Subscription as AbepSubscription } from 'abep-sdk'
import { connectNatsBus } from 'abep-sdk-nats'
import { ResultAsync } from 'neverthrow'
import { createHash } from 'node:crypto'

/**
 * Compatibility shim: the legacy `Bus` (native NATS subjects) is now the
 * abep-sdk NATS transport. The agent code continues to address the exact
 * same subjects — `tool.call.{ext}.{tool}`, `tool.result.{call_id}`,
 * `mailbox.session.{token}`, `sse.session.{token}`, `notify.lifecycle.*` —
 * so wire compatibility with extensions is unchanged.
 */
export type Bus = AbepBus
export type Subscription = AbepSubscription
export type Envelope = AbepEnvelope
export type InboxMsg = AbepInboxMsg

export async function connectBus(natsUrl: string): Promise<ResultAsync<Bus, string>> {
  return ResultAsync.fromPromise(connectNatsBus(natsUrl), e => `abep connect: ${String(e)}`)
}

/** The agent-side role over the abep transport. */
export const Agent = AbepAgent

// wire subject helpers (byte-compatible with extensions)
export const toolCallSubject = (extId: string, name: string) => `tool.call.${extId}.${name}`
export const toolResultSubject = (callId: string) => `tool.result.${callId}`
export const mailboxSubject = (sid: string) => `mailbox.session.${natsToken(sid)}`
export const sseSubject = (sid: string) => `sse.session.${natsToken(sid)}`

// stream names (kept for replayAll callers)
export const STREAM_SSE = 'RCODER_SSE'
export const STREAM_MAILBOX = 'RCODER_MAILBOX'
export const STREAM_NOTIFY = 'RCODER_NOTIFY'
export const BUCKET_SESSION_STATE = 'RCODER_SESSION_STATE'
export const BUCKET_SESSION_IDS = 'RCODER_SESSION_IDS'
export const BUCKET_TOOL = 'RCODER_TOOL'
export const SESSION_LEASE_MS = 30_000
export const MODELS_DEV_KEY = 'models-dev-catalog.json'

export function natsToken(sid: string): string {
  return createHash('sha256').update(sid, 'utf8').digest('base64url').slice(0, 22)
}
