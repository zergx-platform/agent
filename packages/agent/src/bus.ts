import {
  connect,
  DeliverPolicy,
  type JetStreamClient,
  type KV,
  type NatsConnection,
  type Sub,
  type Subscription,
} from 'nats'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { parse, parseLoose } from './json.js'

// Stream / subject topology — must stay byte-compatible with rucoder-sdk-bus
// (the Rust side) so both agent replicas interoperate on the same cluster.

export const STREAM_MAILBOX = 'RCODER_MAILBOX'
export const STREAM_SSE = 'RCODER_SSE'
export const STREAM_NOTIFY = 'RCODER_NOTIFY'
export const STREAM_TOOL_LOG = 'RCODER_TOOL_LOG'
export const BUCKET_TOOL = 'RCODER_TOOL'

/** KV bucket holding per-session run-state leases (running/idle). */
export const BUCKET_SESSION_STATE = 'RCODER_SESSION_STATE'

/** KV bucket holding the cached models.dev catalog (30min TTL). */
export const BUCKET_MODELS_DEV = 'RCODER_MODELS_DEV'
export const MODELS_DEV_KEY = 'catalog'

export const mailboxSubject = (sid: string) => `mailbox.session.${sid}`
export const sseSubject = (sid: string) => `sse.session.${sid}`
export const toolCallSubject = (name: string) => `tool.call.${name}`
export const toolResultSubject = (callId: string) => `tool.result.${callId}`

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

/** Lease TTL for per-session run-state keys (ms). */
const SESSION_LEASE_MS = 30_000

/** TTL for the models.dev catalog KV (30 minutes). */
const MODELS_DEV_TTL_MS = 30 * 60 * 1000

export interface WakeMessage {
  session_name: string
  type: 'user_prompt' | 'interrupt' | 'event'
}

export class Bus {
  constructor(
    private readonly nc: NatsConnection,
    private readonly js: JetStreamClient,
    private readonly sessionState: KV,
    private readonly modelsDev: KV,
  ) {}

  /** Core (non-durable) publish. */
  publish(subject: string, payload: unknown): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      Promise.resolve(
        this.nc.publish(subject, Buffer.from(JSON.stringify(payload))),
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
   * Subscribe to every session's mailbox wake wildcard so a replica can react
   * to newly-enqueued work for any session.
   */
  subscribeMailboxWake(): ResultAsync<Subscription, string> {
    return this.subscribe(MAILBOX_WILDCARD)
  }

  /**
   * Atomically claim the per-session run state: `create` fails if the key
   * already exists (someone else is running), so exactly one replica wins.
   * The key carries a TTL so a crashed holder is automatically released.
   */
  claimSession(sid: string): ResultAsync<boolean, string> {
    return ResultAsync.fromPromise(
      this.sessionState.create(sid, Buffer.from('running')).then(() => true),
      e => `claim session ${sid}: ${String(e)}`,
    ).orElse(err => {
      // 10071 == "wrong last sequence" (key already exists). This is the
      // expected contention case, not a genuine error.
      const apiError = parseClaimError(err)
      if (apiError === 10071) {
        return ResultAsync.fromSafePromise<boolean, string>(
          Promise.resolve(false),
        )
      }
      return ResultAsync.fromPromise<boolean, string>(
        Promise.reject(new Error(err)),
        () => err,
      )
    })
  }

  /** Release the per-session run-state lease (back to idle). */
  releaseSession(sid: string): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      this.sessionState.delete(sid).then(() => undefined),
      e => `release session ${sid}: ${String(e)}`,
    )
  }

  /**
   * Store the models.dev catalog JSON into the shared KV with a 30min TTL so
   * any replica can serve it and stale entries self-expire.
   */
  putModelsDev(json: string): ResultAsync<void, string> {
    return ResultAsync.fromPromise(
      this.modelsDev
        .put(MODELS_DEV_KEY, Buffer.from(json), {
          previousSeq: 0,
        })
        .then(() => undefined),
      e => `put models.dev catalog: ${String(e)}`,
    )
  }

  /** Read the cached models.dev catalog, if present. */
  getModelsDev(): ResultAsync<unknown, string> {
    return ResultAsync.fromPromise(
      this.modelsDev.get(MODELS_DEV_KEY).then(entry =>
        entry === null
          ? null
          : parseLoose(entry.value).match(
              v => v,
              () => null,
            ),
      ),
      e => `get models.dev catalog: ${String(e)}`,
    )
  }

  /**
   * Collect all retained messages on a durable subject via repeated
   * ephemeral ordered-consumer fetches until a batch comes back empty.
   */
  replayAll(stream: string, subject: string): ResultAsync<unknown[], string> {
    return ResultAsync.fromPromise(
      (async () => {
        const out: unknown[] = []
        for (;;) {
          const consumer = await this.js.consumers.get(stream, {
            filterSubjects: subject,
            deliver_policy: DeliverPolicy.All,
          })
          const iter = await consumer.fetch({
            expires: 1000,
            max_messages: 500,
          })
          let got = 0
          for await (const m of iter) {
            got++
            const parsed = parseLoose(Buffer.from(m.data))
            if (parsed.isOk()) out.push(parsed.value)
          }
          await iter.close()
          await consumer.delete()
          if (got === 0) break
        }
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
      // models.dev catalog KV with a 30min TTL.
      const modelsDev = await js.views.kv(BUCKET_MODELS_DEV, {
        history: 1,
        ttl: MODELS_DEV_TTL_MS,
        description: 'rucoder models.dev catalog cache',
      })
      return new Bus(nc, js, sessionState, modelsDev)
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
    const parsed = parseLoose(Buffer.from(m.data))
    if (parsed.isOk()) yield parsed.value
  }
}

const ClaimErrorSchema = z.object({
  api_error: z.object({ err_code: z.number() }).optional(),
})

function parseClaimError(err: string): number | undefined {
  return parse(ClaimErrorSchema, err).match(
    v => v.api_error?.err_code,
    () => undefined,
  )
}
