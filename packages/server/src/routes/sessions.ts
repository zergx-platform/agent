import { zValidator } from '@hono/zod-validator'
import {
  type AgentDeps,
  interruptRun,
  Mailbox,
  Messages,
  mailboxSubject,
  Parts,
  parse,
  parseLoose,
  runSessionTurn,
  Sessions,
  STREAM_SSE,
  sseSubject,
  ToolPartDataSchema,
} from '@rucoder-agent/agent'
import {
  CreateSessionBodySchema,
  ForkBodySchema,
  ModelBodySchema,
  PromptBodySchema,
  RenameBodySchema,
  type SessionRow,
  SessionSettingsBodySchema,
  UndoBodySchema,
} from '@rucoder-agent/schema'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import { type AppEnv, EidDedup } from '../context.js'

/** Serialize a session row into the recoder UI contract. */
function sessionToJson(s: SessionRow): Record<string, unknown> {
  return { ...s, base_image: null, unread: 0 }
}

function err500(c: Context, message: string) {
  return c.json({ ok: false, error: message }, 500)
}

/**
 * Idempotent, reentrant trigger: attempt to claim the session's run lease and
 * run its mailbox to completion. Safe to call from every enqueue point and
 * every replica — exactly one claim wins.
 */
function triggerClaim(deps: AgentDeps, sid: string): void {
  void runSessionTurn(deps, sid).then(
    () => {},
    e => console.error(`[agent] turn crashed (${sid}): ${String(e)}`),
  )
}

// ---- SSE: durable JetStream replay + live, deduped by eid ----

const EidEventSchema = z.object({ eid: z.string().optional() }).passthrough()

async function sseHandler(c: Context<AppEnv>): Promise<Response> {
  const { bus } = c.get('deps')
  const sid = c.req.param('id')
  if (sid === undefined) {
    return c.json({ ok: false, error: 'session not found' }, 404)
  }
  return streamSSE(c, async stream => {
    const subject = sseSubject(sid)

    // Subscribe live BEFORE replaying so the handover can overlap, not drop.
    const subRes = await bus.subscribe(subject)
    if (subRes.isErr()) {
      await stream.writeSSE({
        data: JSON.stringify({
          event: 'error',
          params: { message: subRes.error },
        }),
      })
      return
    }
    const sub = subRes.value

    let closed = false
    stream.onAbort(() => {
      closed = true
      sub.unsubscribe()
    })

    const dedup = new EidDedup()
    const replay = await bus.replayAll(STREAM_SSE, subject)
    if (replay.isOk()) {
      for (const raw of replay.value) {
        const v = EidEventSchema.safeParse(raw)
        if (!v.success) continue
        dedup.mark(v.data.eid)
        await stream.writeSSE({ data: JSON.stringify(raw) })
      }
    }

    for await (const m of sub) {
      if (closed) break
      const parsed = parseLoose(Buffer.from(m.data))
      if (!parsed.isOk()) continue
      const v = EidEventSchema.safeParse(parsed.value)
      if (!v.success) continue
      if (dedup.duplicate(v.data.eid)) continue
      await stream.writeSSE({ data: JSON.stringify(parsed.value) })
    }
  })
}

export const sessionRoutes = new Hono<AppEnv>()
  .get('/', async c => {
    const { db } = c.get('deps')
    const r = await Sessions.list(db)
    return r.isErr()
      ? err500(c, r.error)
      : c.json({ sessions: r.value.map(sessionToJson) })
  })
  .post('/', zValidator('json', CreateSessionBodySchema), async c => {
    const { db } = c.get('deps')
    const b = c.req.valid('json')
    const exists = await Sessions.exists(db, b.name)
    if (exists.isErr()) return err500(c, exists.error)
    if (exists.value) {
      return c.json({ ok: false, error: 'Session already exists' }, 409)
    }
    const name = await Sessions.create(db, b)
    return name.isErr()
      ? err500(c, name.error)
      : c.json({ ok: true, session_name: name.value })
  })
  .get('/:id', async c => {
    const { db } = c.get('deps')
    const r = await Sessions.get(db, c.req.param('id'))
    if (r.isErr()) return err500(c, r.error)
    return r.value === null
      ? c.json({ ok: false, error: 'session not found' }, 404)
      : c.json({ session: sessionToJson(r.value) })
  })
  .delete('/:id', async c => {
    const { db } = c.get('deps')
    const id = c.req.param('id')
    interruptRun(id)
    const r = await Sessions.delete(db, id)
    return r.isErr() ? err500(c, r.error) : c.json({ ok: true })
  })
  .get('/:id/messages', async c => {
    const { db } = c.get('deps')
    const sid = c.req.param('id')
    const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)
    const before = c.req.query('before') ?? null
    const tipRes = await Sessions.tip(db, sid)
    const tipId = tipRes.isErr() ? null : tipRes.value
    const r = await Messages.chain(db, tipId, limit, before)
    return r.isErr() ? err500(c, r.error) : c.json({ messages: r.value })
  })
  .post('/:id/prompt', zValidator('json', PromptBodySchema), async c => {
    const deps = c.get('deps')
    const sid = c.req.param('id')
    const { prompt } = c.req.valid('json')

    const session = await Sessions.get(deps.db, sid)
    if (session.isErr()) return err500(c, session.error)
    if (session.value === null) {
      return c.json({ ok: false, error: 'session not found' }, 404)
    }

    // Persist the user message first (chained onto the tip) so the turn loop
    // never runs against a history missing the prompt.
    const tipRes = await Sessions.tip(deps.db, sid)
    const tipId = tipRes.isErr() ? null : tipRes.value
    const insert = await Messages.insert(deps.db, 'user', prompt, tipId)
    if (insert.isErr()) return err500(c, insert.error)
    await Sessions.setTip(deps.db, sid, insert.value)

    const enq = await Mailbox.enqueue(deps.db, sid, 'user_prompt', {
      text: prompt,
    })
    if (enq.isErr()) return err500(c, enq.error)

    // Wake any replica via the durable mailbox subject. Every replica tries a
    // claim; exactly one wins and drains the mailbox (idempotent, reentrant).
    void deps.bus
      .publishStream(mailboxSubject(sid), {
        type: 'user_prompt',
        session_name: sid,
      })
      .then(() => undefined)

    void triggerClaim(deps, sid)
    return c.json({ ok: true })
  })
  .get('/:id/stream', sseHandler)
  .get('/:id/events', sseHandler)
  .get('/:id/todos', async c => {
    const deps = c.get('deps')
    const url = `${deps.config.memoryUrl.replace(/\/$/, '')}/api/v1/todos?session_name=${c.req.param('id')}`
    const res = await ResultAsync.fromPromise(fetch(url), () => null)
    if (res.isErr() || res.value === null) {
      return err500(c, 'memory service unreachable')
    }
    const body = await ResultAsync.fromPromise(res.value.json(), () => ({}))
    return c.json(body.isOk() ? body.value : {})
  })
  .post('/:id/fork', zValidator('json', ForkBodySchema), async c => {
    const deps = c.get('deps')
    const pid = c.req.param('id')
    const b = c.req.valid('json')
    const parent = await Sessions.get(deps.db, pid)
    if (parent.isErr()) return err500(c, parent.error)
    if (parent.value === null) {
      return c.json({ ok: false, error: 'session not found' }, 404)
    }
    const p = parent.value

    const exists = await Sessions.exists(deps.db, b.name)
    if (exists.isErr()) return err500(c, exists.error)
    if (exists.value) {
      return c.json({ ok: false, error: 'Session already exists' }, 409)
    }

    const name = await Sessions.create(deps.db, {
      name: b.name,
      model: p.model,
      preset: p.preset,
      tipId: p.tip_id,
    })
    return name.isErr()
      ? err500(c, name.error)
      : c.json({ ok: true, session_name: name.value })
  })
  .post('/:id/rename', zValidator('json', RenameBodySchema), async c => {
    const deps = c.get('deps')
    const oldName = c.req.param('id')
    const b = c.req.valid('json')

    if (b.name === oldName) {
      return c.json({ ok: true, session_name: oldName })
    }
    const parent = await Sessions.get(deps.db, oldName)
    if (parent.isErr()) return err500(c, parent.error)
    if (parent.value === null) {
      return c.json({ ok: false, error: 'session not found' }, 404)
    }
    const exists = await Sessions.exists(deps.db, b.name)
    if (exists.isErr()) return err500(c, exists.error)
    if (exists.value) {
      return c.json({ ok: false, error: 'Session already exists' }, 409)
    }
    const p = parent.value

    // rename = fork (copy tip) into the new name + delete the old name.
    // Messages are shared COW; deleting the old session leaves history intact.
    const created = await Sessions.create(deps.db, {
      name: b.name,
      model: p.model,
      preset: p.preset,
      tipId: p.tip_id,
    })
    if (created.isErr()) return err500(c, created.error)
    const removed = await Sessions.delete(deps.db, oldName)
    if (removed.isErr()) return err500(c, removed.error)
    return c.json({ ok: true, session_name: b.name })
  })
  .post('/:id/model', zValidator('json', ModelBodySchema), async c => {
    const { db } = c.get('deps')
    const r = await Sessions.setModel(
      db,
      c.req.param('id'),
      c.req.valid('json').model,
    )
    return r.isErr()
      ? err500(c, r.error)
      : c.json({ model: c.req.valid('json').model })
  })
  .post('/:id/undo', zValidator('json', UndoBodySchema), async c => {
    const deps = c.get('deps')
    const sid = c.req.param('id')
    const { message_id } = c.req.valid('json')

    const session = await Sessions.get(deps.db, sid)
    if (session.isErr()) return err500(c, session.error)
    const s = session.value
    if (s === null)
      return c.json({ ok: false, error: 'session not found' }, 404)

    const tip = s.tip_id
    if (tip === null || tip === '') {
      return c.json({ ok: false, undone: false })
    }
    const targetId = message_id ?? tip
    const target = await Messages.get(deps.db, targetId)
    if (target.isErr()) return err500(c, target.error)
    if (target.value === null) return c.json({ ok: false, undone: false })

    // undo == move the tip pointer back; messages are append-only and never
    // physically deleted (COW). At the chain head this becomes a no-op.
    await Sessions.setTip(deps.db, sid, target.value.prev_id)

    return c.json({ ok: true, undone: true })
  })
  .post('/:id/read', async c => c.json({ ok: true }))
  .get('/:id/state', async c => c.json({ status: 'idle', parts: [] }))
  .get('/:id/mailbox', async c => {
    const { db } = c.get('deps')
    const r = await Mailbox.list(db, c.req.param('id'))
    return r.isErr() ? err500(c, r.error) : c.json({ entries: r.value })
  })
  .get('/:id/changes', async c => {
    const { db } = c.get('deps')
    const sid = c.req.param('id')
    const tipRes = await Sessions.tip(db, sid)
    const tipId = tipRes.isErr() ? null : tipRes.value
    const chain = await Messages.chain(db, tipId, 100_000, null)
    if (chain.isErr()) return err500(c, chain.error)
    const ids = chain.value.map(m => m.id)
    const partsRes = await Parts.listByMessages(db, ids)
    if (partsRes.isErr()) return err500(c, partsRes.error)

    const changes: Array<Record<string, unknown>> = []
    for (const p of partsRes.value) {
      if (p.type !== 'tool' || p.change_id === null) continue
      const data = parse(ToolPartDataSchema, p.data)
      const name = data.isOk() ? data.value.name : 'tool'
      changes.push({
        change_id: p.change_id,
        tool_name: name,
        timestamp: '',
        message_id: p.message_id,
        content: '',
        seq: p.seq,
      })
    }
    return c.json({ changes })
  })
  .patch(
    '/:id/settings',
    zValidator('json', SessionSettingsBodySchema),
    async c => {
      const { db } = c.get('deps')
      const sid = c.req.param('id')
      const b = c.req.valid('json')
      const r = await Sessions.updateSettings(db, sid, {
        model: b.model,
        preset: b.preset,
      })
      if (r.isErr()) return err500(c, r.error)
      const s = await Sessions.get(db, sid)
      if (s.isErr()) return err500(c, s.error)
      return s.value === null
        ? c.json({ ok: false, error: 'session not found' }, 404)
        : c.json({ session: sessionToJson(s.value) })
    },
  )
  .post('/:id/interrupt', async c => {
    const deps = c.get('deps')
    const sid = c.req.param('id')
    // 1. Local mid-stream abort (this replica).
    interruptRun(sid)
    // 2. Durable: enqueue + wake publish so the replica holding the session
    //    aborts its in-flight stream.
    const enq = await Mailbox.enqueue(deps.db, sid, 'interrupt', {})
    if (enq.isErr()) return err500(c, enq.error)
    void deps.bus
      .publishStream(mailboxSubject(sid), {
        type: 'interrupt',
        session_name: sid,
      })
      .then(() => undefined)
    void triggerClaim(deps, sid)
    return c.json({ interrupted: true })
  })
