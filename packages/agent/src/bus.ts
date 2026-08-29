import { createHash } from 'node:crypto'
import type {
  Bus as AbepBus,
  Envelope as AbepEnvelope,
  InboxMsg as AbepInboxMsg,
  Subscription as AbepSubscription,
} from '@abc-protocol/sdk'
import { Agent as AbepAgent, connectNatsBus } from '@abc-protocol/sdk'
import { ResultAsync } from 'neverthrow'

/**
 * Compatibility shim: the legacy `Bus` (native NATS subjects) is the
 * @abc-protocol/sdk NATS transport. Wire subjects use the abc protocol
 * prefix (`abc.`) and are shared verbatim with the extension SDKs.
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
    e => `abc connect: ${String(e)}`,
  )
}

/** The agent-side role over the abc transport. */
export const Agent = AbepAgent

// wire subject helpers (abc protocol subjects, prefix `abc.`)
export const mailboxSubject = (sid: string) => `abc.mailbox.${natsToken(sid)}`
export const sseSubject = (sid: string) =>
  `abc.session.events.${natsToken(sid)}`

// stream/bucket names on the abc wire (session events share the mailbox
// stream; the object bucket carries tool payloads)
export const STREAM_MAILBOX = 'ABC_MAILBOX'
export const BUCKET_SESSION_STATE = 'abc-session-state'
export const BUCKET_TOOL = 'ABC_TOOL'
export const SESSION_LEASE_MS = 30_000
export const MODELS_DEV_KEY = 'models-dev-catalog.json'

export function natsToken(sid: string): string {
  return createHash('sha256')
    .update(sid, 'utf8')
    .digest('base64url')
    .slice(0, 22)
}
