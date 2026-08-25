import { createHash } from 'node:crypto'
import {
  connect,
  consumerOpts,
  createInbox,
  DeliverPolicy,
  type JetStreamClient,
  type JsMsg,
  type KV,
  type NatsConnection,
  RequestStrategy,
  type Sub,
  type Subscription,
} from 'nats'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { parse } from './json.js'

// Stream / subject topology — must stay byte-compatible with rucoder-sdk-bus
// (the Rust side) so both agent replicas interoperate on the same cluster.

export const STREAM_MAILBOX = 'RCODER_MAILBOX'
export const STREAM_SSE = 'RCODER_SSE'
export const STREAM_NOTIFY = 'RCODER_NOTIFY'
export const STREAM_TOOL_LOG = 'RCODER_TOOL_LOG'
export const BUCKET_TOOL = 'RCODER_TOOL'

/** KV bucket holding per-session run-state leases (running/idle). */
export const BUCKET_SESSION_STATE = 'RCODER_SESSION_STATE'

/** KV bucket caching the per-session LLM-context message id list (24h TTL). */
export const BUCKET_SESSION_IDS = 'RCODER_SESSION_IDS'

/** Object-store key under BUCKET_TOOL holding the cached models.dev catalog. */
export const MODELS_DEV_KEY = 'models-dev-catalog.json'

export const mailboxSubject = (sid: string) =>
  `mailbox.session.${natsToken(sid)}`
export const sseSubject = (sid: string) => `sse.session.${natsToken(sid)}`
/**
 * Namespaced tool-call subject: `tool.call.{extension-id}.{tool}`.
 * Namespacing prevents tool-name collisions between extensions (two
 * extensions exposing `write` would otherwise intercept each other's calls
 * on the flat subject).
 */
export const toolCallSubject = (extId: string, name: string) =>
  `tool.call.${extId}.${name}`
export const toolResultSubject = (callId: string) => `tool.result.${callId}`

/**
 * Deterministic NATS-safe token for an arbitrary session name. Session
 * names may contain characters that are illegal in NATS subject tokens and
 * KV keys (`:`, `#`, space, …). Everywhere the agent would embed a session
 * name in NATS infrastructure (subjects, lease keys) it embeds this token
 * instead — the real session name always travels in the payload.
 * base64url alphabet [A-Za-z0-9_-] is subject-legal; 22 chars ≈ 132 bits.
 */
export const natsToken = (sid: string): string =>
  createHash('sha256').update(sid, 'utf8').digest('base64url').slice(0, 22)

/** Wildcard covering every session mailbox wake subject. */
export const MAILBOX_WILDCARD = 'mailbox.session.>'

export interface ToolCallEnvelope {
  call_id: string
  arguments: Record<string, unknown>
}

const STREAMS: Array<{ name: string; subjects: string[] }> = [
  { name: STREAM_MAILBOX, subjects: ['mailbox.session.>'] },
  { name: STREAM_SSE, subjects: ['sse.session.>'] },
  { name: STREAM_NOTIFY, subjects: ['notify.>'] },
  { name: STREAM_TOOL_LOG, subjects: ['tool.log.>'] },
]

const DAY_NS = 24 * 3600 * 1_000_000_000

/** TTL (millis) for the session id-list cache (24h). */
export const SESSION_IDS_TTL_MS = 24 * 3600 * 1000

/** Lease TTL for per-session run-state keys (ms). */
export const SESSION_LEASE_MS = 30_000

export interface WakeMessage {
  session_name: string
  type: 'user_prompt' | 'interrupt' | 'event'
}

export class Bus {
  constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient,
    private readonly sessionState: KV,
    private readonly sessionIds: KV,
    private readonly requestTimeoutMs = 2000,
  ) {}

  /** Core (non-durable) publish. `reply` sets the inbox extensions answer
   *  (e.g. `tool.result.{call_id}` for tool calls — the Go/TS extension SDKs
   *  only respond via msg.Respond, i.e. when a reply subject is present). */
  publish(
    subject: string,
    payload: unknown,
    reply?: string,
  ): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      Promise.resolve(
        this.nc.publish(subject, Buffer.from(JSON.stringify(payload)), {
          reply,
        }),
      ),
      e => `publish ${subject}: ${String(e)}`,
    )
  }

  /** Durable JetStream publish (SSE events, mailbox wake signals). */
  publishStream(subject: string, payload: unknown): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      this.js
        .publish(subject, Buffer.from(JSON.stringify(payload)))
        .then(() => undefined),
      e => `stream publish ${subject}: ${String(e)}`,
    )
  }

  /** Core subscribe (live events / tool results). */
  subscribe(subject: string): ResultAsync<Subscription, string> {
    return ResultAsync.fromPromise(
      Promise.resolve(this.nc.subscribe(subject)),
      e => `subscribe ${subject}: ${String(e)}`,
    )
  }

  /**
   * NATS request/reply (auto reply-inbox). Resolves with the reply payload
   * bytes; the caller validates them with a zod schema.
   */
  request(subject: string, payload: unknown): ResultAsync<Uint8Array, string> {
    return ResultAsync.fromPromise(
      this.nc
        .request(subject, Buffer.from(JSON.stringify(payload)), {
          timeout: this.requestTimeoutMs,
        })
        .then(m => m.data),
      e => `request ${subject}: ${String(e)}`,
    )
  }

  /**
   * NATS request/reply fan-out: broadcast to every responder on `subject` and
   * collect all replies until `maxWait` expires (timer strategy). Returns the
   * raw reply payloads; the caller validates each with a zod schema.
   */
  requestMany(
    subject: string,
    payload: unknown,
    maxWaitMs: number,
  ): ResultAsync<Uint8Array[], string> {
    return ResultAsync.fromPromise(
      (async () => {
        const replies = await this.nc.requestMany(
          subject,
          Buffer.from(JSON.stringify(payload)),
          { strategy: RequestStrategy.Timer, maxWait: maxWaitMs },
        )
        const out: Uint8Array[] = []
        for await (const m of replies) {
          out.push(m.data)
        }
        return out
      })(),
      e => `requestMany ${subject}: ${String(e)}`,
    )
  }

  /**
   * Subscribe to every session's mailbox wake wildcard so a replica can react
   * to newly-enqueued work for any session.
   */
  subscribeMailboxWake(): ResultAsync<Subscription, string> {
    return this.subscribe(MAILBOX_WILDCARD)
  }

  /**
   * Durable, load-shared consumption of the mailbox stream
   * (`RCODER_MAILBOX`, subjects `mailbox.session.>`). Every replica calls
   * this with the same durable name + queue group, so each JetStream message
   * is delivered to exactly one replica, redelivered on crash (unacked), and
   * the queue advances only via explicit ack — replacing the old fire-and-
   * forget wake signal with an actual message queue the agent drains.
   */
  consumeMailbox(): ResultAsync<Sub<JsMsg>, string> {
    return ResultAsync.fromPromise(
      this.js.subscribe(
        MAILBOX_WILDCARD,
        consumerOpts()
          .durable('agent-mailbox-push')
          .queue('agent-mailbox')
          .deliverTo(createInbox())
          .filterSubject(MAILBOX_WILDCARD)
          .ackExplicit()
          .manualAck()
          .deliverAll()
          .ackWait(30_000)
          .maxDeliver(-1)
          .maxAckPending(1024),
      ),
      e => `mailbox consumer: ${String(e)}`,
    )
  }

  /**
   * Publish one mailbox message (user_prompt / event) onto the durable stream.
   * `msgId` dedupes publisher-side; a duplicate publish within the stream's
   * duplicate window is rejected by the server.
   */
  publishMailbox(
    sessionName: string,
    type: 'user_prompt' | 'event',
    payload: unknown,
    msgId: string,
  ): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      this.js
        .publish(
          mailboxSubject(sessionName),
          Buffer.from(
            JSON.stringify({
              id: msgId,
              session_name: sessionName,
              type,
              payload,
            }),
          ),
          { msgID: msgId },
        )
        .then(() => undefined),
      e => `publish mailbox ${sessionName}: ${String(e)}`,
    )
  }

  /**
   * Atomically claim the per-session run state: `create` fails if the key
   * already exists (someone else is running), so exactly one replica wins.
   * The key carries a TTL so a crashed holder is automatically released.
   * Returns the KV revision on success (needed to renew without resurrecting
   * a lease we no longer own), or `null` when another replica holds it.
   */
  claimSession(sid: string): ResultAsync<number | null, string> {
    const key = natsToken(sid)
    return ResultAsync.fromPromise(
      this.sessionState.create(key, Buffer.from('running')),
      e => (e instanceof Error ? e : new Error(String(e))),
    ).orElse(err => {
      // KV `create` throws a NatsError with `api_error.err_code === 10071`
      // ("wrong last sequence") when the key already exists — that's the
      // expected contention case, not a genuine error. Handle the raw error
      // (before it gets stringified into the Result error text).
      const code = (err as { api_error?: { err_code?: number } }).api_error
        ?.err_code
      if (code === 10071) {
        return ResultAsync.fromSafePromise<number | null, string>(
          Promise.resolve(null),
        )
      }
      return ResultAsync.fromPromise<number | null, string>(
        Promise.reject(err),
        e => String(e),
      )
    })
  }

  /** Release the per-session run-state lease (back to idle). */
  releaseSession(sid: string): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      this.sessionState.delete(natsToken(sid)).then(() => undefined),
      e => `release session ${sid}: ${String(e)}`,
    )
  }

  /** True while the per-session run lease is held (someone is running it). */
  isSessionRunning(sid: string): ResultAsync<boolean, string> {
    return ResultAsync.fromPromise(
      this.sessionState.get(natsToken(sid)).then(e => e !== null),
      e => `session running ${sid}: ${String(e)}`,
    )
  }

  /**
   * Extend the per-session lease TTL (a turn can outlive the 30s TTL). Uses
   * a compare-and-swap `update(key, value, revision)`: the call fails if the
   * key no longer exists or a competing holder changed its revision, so a
   * stale holder can never resurrect a lease it lost.
   */
  renewSession(sid: string, revision: number): ResultAsync<boolean, string> {
    return ResultAsync.fromPromise(
      this.sessionState
        .update(natsToken(sid), Buffer.from('running'), revision)
        .then(() => true),
      e => (e instanceof Error ? e : new Error(String(e))),
    ).orElse(err => {
      const code = (err as { api_error?: { err_code?: number } }).api_error
        ?.err_code
      if (code === 10071) {
        return ResultAsync.fromSafePromise<boolean, string>(
          Promise.resolve(false),
        )
      }
      return ResultAsync.fromPromise<boolean, string>(Promise.reject(err), e =>
        String(e),
      )
    })
  }

  /** Read the cached session context id list, if present. */
  getSessionIds(sid: string): ResultAsync<string[] | null, string> {
    return ResultAsync.fromPromise(
      this.sessionIds.get(natsToken(sid)).then(e => {
        if (e === null) return null
        const parsed = parse(z.array(z.string()), e.string())
        return parsed.isOk() ? parsed.value : null
      }),
      e => `get session ids: ${String(e)}`,
    )
  }

  /** Write the session context id list (full overwrite). */
  putSessionIds(sid: string, ids: string[]): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      this.sessionIds
        .put(natsToken(sid), Buffer.from(JSON.stringify(ids)))
        .then(() => undefined),
      e => `put session ids: ${String(e)}`,
    )
  }

  /** Append one message id to the session context id list (no-op on miss). */
  appendSessionId(sid: string, id: string): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      this.sessionIds.get(natsToken(sid)).then(e => {
        if (e === null) return undefined
        const parsed = parse(z.array(z.string()), e.string())
        const ids = parsed.isOk() ? parsed.value : []
        ids.push(id)
        return this.sessionIds
          .put(natsToken(sid), Buffer.from(JSON.stringify(ids)))
          .then(() => undefined)
      }),
      e => `append session id: ${String(e)}`,
    )
  }

  /** Drop the session context id-list cache (force a re-walk). */
  deleteSessionIds(sid: string): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      this.sessionIds.delete(natsToken(sid)).then(() => undefined),
      e => `delete session ids: ${String(e)}`,
    )
  }

  /**
   * Store the models.dev catalog JSON into the shared KV with a 30min TTL so
   * any replica can serve it and stale entries self-expire.
   */
  putModelsDev(json: string): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      this.js.views
        .os(BUCKET_TOOL)
        .then(os => os.putBlob({ name: MODELS_DEV_KEY }, Buffer.from(json)))
        .then(() => undefined),
      e => `put models.dev catalog: ${String(e)}`,
    )
  }

  /** Read the cached models.dev catalog, if present. */
  getModelsDev(): ResultAsync<unknown, string> {
    return ResultAsync.fromPromise(
      this.getObject(MODELS_DEV_KEY).match(
        bytes =>
          bytes.length === 0
            ? null
            : parse(z.unknown(), bytes).match(
                v => v,
                () => null,
              ),
        () => null,
      ),
      e => `get models.dev catalog: ${String(e)}`,
    )
  }

  /**
   * Collect all retained messages on a durable subject via a single
   * start-at-sequence-1 fetch with a large batch size. History is bounded by
   * the stream's max_age, so a single pull is sufficient.
   */
  replayAll(stream: string, subject: string): ResultAsync<unknown[], string> {
    return ResultAsync.fromPromise(
      (async () => {
        const consumer = await this.js.consumers.get(stream, {
          filterSubjects: subject,
          deliver_policy: DeliverPolicy.StartSequence,
          opt_start_seq: 1,
        })
        const out: unknown[] = []
        // Loop `fetch` until an empty batch (the fetch iterator ends with zero
        // messages when nothing is left within the expiry) instead of a single
        // fetch that truncates long replays at the expiry deadline.
        for (;;) {
          let got = 0
          const iter = await consumer.fetch({
            expires: 5000,
            max_messages: 10_000,
          })
          for await (const m of iter) {
            got++
            const parsed = parse(z.unknown(), Buffer.from(m.data))
            if (parsed.isOk()) out.push(parsed.value)
          }
          if (got === 0) break
        }
        await consumer.delete()
        return out
      })(),
      e => `replay ${stream}/${subject}: ${String(e)}`,
    )
  }

  /** Fetch a large tool-result blob from the shared object store. */
  getObject(name: string): ResultAsync<Buffer, string> {
    return ResultAsync.fromPromise(
      (async () => {
        const os = await this.js.views.os(BUCKET_TOOL)
        const view = await os.get(name)
        if (view === null) return Buffer.alloc(0)
        const chunks: Buffer[] = []
        const reader = view.data.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(Buffer.from(value))
        }
        return Buffer.concat(chunks)
      })(),
      e => `get object ${name}: ${String(e)}`,
    )
  }

  close(): void {
    void this.nc.close()
  }
}

export function connectBus(url: string): ResultAsync<Bus, string> {
  return ResultAsync.fromPromise(
    (async () => {
      const nc = await connect({ servers: url })
      const js = nc.jetstream()
      const jsm = await nc.jetstreamManager()
      for (const s of STREAMS) {
        await ensureStream(jsm, s)
      }
      // Object store for large tool results.
      await ensureObjectStore(js)
      // Per-session run-state KV with a TTL so crashed holders self-release.
      const sessionState = await js.views.kv(BUCKET_SESSION_STATE, {
        history: 1,
        ttl: SESSION_LEASE_MS,
        description: 'rucoder per-session run-state leases',
      })
      // Per-session LLM-context id-list cache (24h TTL).
      const sessionIds = await js.views.kv(BUCKET_SESSION_IDS, {
        history: 1,
        ttl: SESSION_IDS_TTL_MS,
        description: 'rucoder per-session context id list cache',
      })
      return new Bus(nc, js, sessionState, sessionIds)
    })(),
    e => `nats connect: ${String(e)}`,
  )
}

type JetStreamManager = import('nats').JetStreamManager

function ensureStream(
  jsm: JetStreamManager,
  s: { name: string; subjects: string[] },
): Promise<unknown> {
  return jsm.streams.info(s.name).then(
    () => undefined,
    () =>
      jsm.streams.add({
        name: s.name,
        subjects: s.subjects,
        max_age: DAY_NS,
      }),
  )
}

function ensureObjectStore(js: JetStreamClient): Promise<unknown> {
  return js.views.os(BUCKET_TOOL).then(
    () => undefined,
    () =>
      js.views.os(BUCKET_TOOL, {
        description: 'rucoder tool results',
        ttl: DAY_NS,
      }),
  )
}

/** Adapt a NATS subscription to an async iterator of parsed JSON values. */
export async function* subscriptionToIterator(
  sub: Sub<import('nats').Msg>,
): AsyncGenerator<unknown, void, unknown> {
  for await (const m of sub) {
    const parsed = parse(z.unknown(), Buffer.from(m.data))
    if (parsed.isOk()) yield parsed.value
  }
}
