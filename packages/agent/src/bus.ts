import { createHash } from 'node:crypto'
import type {
  Bus as AbepBus,
  Envelope as AbepEnvelope,
  InboxMsg as AbepInboxMsg,
  Subscription as AbepSubscription,
} from 'abep-sdk'
import { Agent as AbepAgent } from 'abep-sdk'
import { connectNatsBus } from 'abep-sdk-nats'
import { ResultAsync } from 'neverthrow'

/**
 * Compatibility shim: the legacy `Bus` (native NATS subjects) is now the
 * abep-sdk NATS transport. Wire subjects use the abep protocol prefix
 * (`abep.`) and are shared verbatim with the extension SDKs.
 */
export type Bus = AbepBus
export type Subscription = AbepSubscription
export type Envelope = AbepEnvelope
export type InboxMsg = AbepInboxMsg

export async function connectBus(
  natsUrl: string,
): Promise<ResultAsync<Bus, string>> {
  return ResultAsync.fromPromise(
    connectNatsBus(natsUrl),
    e => `abep connect: ${String(e)}`,
  )
}

/** The agent-side role over the abep transport. */
export const Agent = AbepAgent

// wire subject helpers (abep protocol subjects, prefix `abep.`)
export const mailboxSubject = (sid: string) => `abep.mailbox.${natsToken(sid)}`
export const sseSubject = (sid: string) =>
  `abep.session.events.${natsToken(sid)}`

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
  return createHash('sha256')
    .update(sid, 'utf8')
    .digest('base64url')
    .slice(0, 22)
}
