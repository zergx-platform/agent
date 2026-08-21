import { $, createRoute, OpenAPIHono } from '@hono/zod-openapi'
import {
  type AgentDeps,
  interruptRun,
  Mailbox,
  Messages,
  mailboxSubject,
  Parts,
  parse,
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
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
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
    console.log(`[sse] connected sid=${sid} subject=${subject}`)

    // Subscribe live BEFORE replaying so the handover can overlap, not drop.
    const subRes = await bus.subscribe(subject)
    if (subRes.isErr()) {
      console.log(`[sse] subscribe failed: ${subRes.error}`)
      await stream.writeSSE({
        data: JSON.stringify({
          event: 'error',
          params: { message: subRes.error },
        }),
      })
      return
    }
    const sub = subRes.value
    console.log(`[sse] subscribed`)

    let closed = false
    stream.onAbort(() => {
      closed = true
      sub.unsubscribe()
    })

    const dedup = new EidDedup()
    const replay = await bus.replayAll(STREAM_SSE, subject)
    console.log(`[sse] replay done, isOk=${replay.isOk()}, n=${replay.isOk() ? replay.value.length : replay.error}`)
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
      const parsed = parse(EidEventSchema, Buffer.from(m.data))
      if (!parsed.isOk()) continue
      const v = parsed.value
      if (dedup.duplicate(v.eid)) continue
      console.log(`[sse] live event=${v.event}`)
      await stream.writeSSE({ data: JSON.stringify(v) })
    }
  })
}

const SessionJsonSchema = z.record(z.string(), z.unknown())

const ErrorSchema = z.object({ ok: z.boolean(), error: z.string() })

// ---- route definitions ----

const listSessionsRoute = createRoute({
  method: 'get',
  path: '/sessions',
  summary: 'List sessions',
  responses: {
    200: {
      description: 'Sessions',
      content: {
        'application/json': {
          schema: z.object({ sessions: z.array(z.unknown()) }),
        },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const createSessionRoute = createRoute({
  method: 'post',
  path: '/sessions',
  summary: 'Create a session',
  request: {
    body: {
      content: { 'application/json': { schema: CreateSessionBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Created',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean(), session_name: z.string() }),
        },
      },
    },
    409: {
      description: 'Exists',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const getSessionRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}',
  summary: 'Get a session',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Session',
      content: {
        'application/json': {
          schema: z.object({ session: SessionJsonSchema }),
        },
      },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const deleteSessionRoute = createRoute({
  method: 'delete',
  path: '/sessions/{id}',
  summary: 'Delete a session',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Ok',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const listMessagesRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}/messages',
  summary: 'List messages',
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({
      limit: z.string().optional(),
      before: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Messages',
      content: {
        'application/json': {
          schema: z.object({ messages: z.array(z.unknown()) }),
        },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const promptRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/prompt',
  summary: 'Send a user prompt',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: PromptBodySchema } } },
  },
  responses: {
    200: {
      description: 'Ok',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const forkRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/fork',
  summary: 'Fork a session',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: ForkBodySchema } } },
  },
  responses: {
    200: {
      description: 'Forked',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean(), session_name: z.string() }),
        },
      },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    409: {
      description: 'Exists',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const renameRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/rename',
  summary: 'Rename a session',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: RenameBodySchema } } },
  },
  responses: {
    200: {
      description: 'Renamed',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean(), session_name: z.string() }),
        },
      },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    409: {
      description: 'Exists',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const modelRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/model',
  summary: 'Set session model',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: ModelBodySchema } } },
  },
  responses: {
    200: {
      description: 'Model',
      content: {
        'application/json': { schema: z.object({ model: z.string() }) },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const undoRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/undo',
  summary: 'Undo (move tip pointer back)',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: UndoBodySchema } } },
  },
  responses: {
    200: {
      description: 'Undone',
      content: {
        'application/json': {
          schema: z.object({ ok: z.boolean(), undone: z.boolean() }),
        },
      },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const readRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/read',
  summary: 'Mark read',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Ok',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
})

const stateRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}/state',
  summary: 'Session state',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'State',
      content: {
        'application/json': {
          schema: z.object({ status: z.string(), parts: z.array(z.unknown()) }),
        },
      },
    },
  },
})

const mailboxRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}/mailbox',
  summary: 'List mailbox entries',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Entries',
      content: {
        'application/json': {
          schema: z.object({ entries: z.array(z.unknown()) }),
        },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const changesRoute = createRoute({
  method: 'get',
  path: '/sessions/{id}/changes',
  summary: 'List tool changes',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Changes',
      content: {
        'application/json': {
          schema: z.object({ changes: z.array(z.unknown()) }),
        },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const settingsRoute = createRoute({
  method: 'patch',
  path: '/sessions/{id}/settings',
  summary: 'Update session settings',
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: SessionSettingsBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated session',
      content: {
        'application/json': {
          schema: z.object({ session: SessionJsonSchema }),
        },
      },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: ErrorSchema } },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const interruptRoute = createRoute({
  method: 'post',
  path: '/sessions/{id}/interrupt',
  summary: 'Interrupt an in-flight run',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Interrupted',
      content: {
        'application/json': { schema: z.object({ interrupted: z.boolean() }) },
      },
    },
    500: {
      description: 'Error',
      content: { 'application/json': { schema: ErrorSchema } },
    },
  },
})

const sessionOpenapi = new OpenAPIHono<AppEnv>()
  .openapi(listSessionsRoute, async c => {
    const { db } = c.get('deps')
    const r = await Sessions.list(db)
    return r.isErr()
      ? err500(c, r.error)
      : c.json({ sessions: r.value.map(sessionToJson) }, 200)
  })
  .openapi(createSessionRoute, async c => {
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
      : c.json({ ok: true, session_name: name.value }, 200)
  })
  .openapi(getSessionRoute, async c => {
    const { db } = c.get('deps')
    const r = await Sessions.get(db, c.req.valid('param').id)
    if (r.isErr()) return err500(c, r.error)
    return r.value === null
      ? c.json({ ok: false, error: 'session not found' }, 404)
      : c.json({ session: sessionToJson(r.value) }, 200)
  })
  .openapi(deleteSessionRoute, async c => {
    const { db } = c.get('deps')
    const id = c.req.valid('param').id
    interruptRun(id)
    const r = await Sessions.delete(db, id)
    return r.isErr() ? err500(c, r.error) : c.json({ ok: true }, 200)
  })
  .openapi(listMessagesRoute, async c => {
    const { db } = c.get('deps')
    const { id } = c.req.valid('param')
    const q = c.req.valid('query')
    const limit = Number.parseInt(q.limit ?? '50', 10)
    const before = q.before ?? null
    const tipRes = await Sessions.tip(db, id)
    const tipId = tipRes.isErr() ? null : tipRes.value
    const r = await Messages.chain(db, tipId, limit, before)
    return r.isErr() ? err500(c, r.error) : c.json({ messages: r.value }, 200)
  })
  .openapi(promptRoute, async c => {
    const deps = c.get('deps')
    const { id } = c.req.valid('param')
    const { prompt } = c.req.valid('json')

    const session = await Sessions.get(deps.db, id)
    if (session.isErr()) return err500(c, session.error)
    if (session.value === null) {
      return c.json({ ok: false, error: 'session not found' }, 404)
    }

    // Persist the user message first (chained onto the tip) so the turn loop
    // never runs against a history missing the prompt.
    const tipRes = await Sessions.tip(deps.db, id)
    const tipId = tipRes.isErr() ? null : tipRes.value
    const insert = await Messages.insert(deps.db, 'user', prompt, tipId)
    if (insert.isErr()) return err500(c, insert.error)
    await Sessions.setTip(deps.db, id, insert.value)

    const enq = await Mailbox.enqueue(deps.db, id, 'user_prompt', {
      text: prompt,
    })
    if (enq.isErr()) return err500(c, enq.error)

    // Wake any replica via the durable mailbox subject. Every replica tries a
    // claim; exactly one wins and drains the mailbox (idempotent, reentrant).
    void deps.bus
      .publishStream(mailboxSubject(id), {
        type: 'user_prompt',
        session_name: id,
      })
      .then(() => undefined)

    void triggerClaim(deps, id)
    return c.json({ ok: true }, 200)
  })
  .openapi(forkRoute, async c => {
    const deps = c.get('deps')
    const pid = c.req.valid('param').id
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
      : c.json({ ok: true, session_name: name.value }, 200)
  })
  .openapi(renameRoute, async c => {
    const deps = c.get('deps')
    const oldName = c.req.valid('param').id
    const b = c.req.valid('json')

    if (b.name === oldName) {
      return c.json({ ok: true, session_name: oldName }, 200)
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
    return c.json({ ok: true, session_name: b.name }, 200)
  })
  .openapi(modelRoute, async c => {
    const { db } = c.get('deps')
    const { id } = c.req.valid('param')
    const { model } = c.req.valid('json')
    const r = await Sessions.setModel(db, id, model)
    return r.isErr() ? err500(c, r.error) : c.json({ model }, 200)
  })
  .openapi(undoRoute, async c => {
    const deps = c.get('deps')
    const sid = c.req.valid('param').id
    const { message_id } = c.req.valid('json')

    const session = await Sessions.get(deps.db, sid)
    if (session.isErr()) return err500(c, session.error)
    const s = session.value
    if (s === null)
      return c.json({ ok: false, error: 'session not found' }, 404)

    const tip = s.tip_id
    if (tip === null || tip === '') {
      return c.json({ ok: false, undone: false }, 200)
    }
    const targetId = message_id ?? tip
    const target = await Messages.get(deps.db, targetId)
    if (target.isErr()) return err500(c, target.error)
    if (target.value === null) return c.json({ ok: false, undone: false }, 200)

    // undo == move the tip pointer back; messages are append-only and never
    // physically deleted (COW). At the chain head this becomes a no-op.
    await Sessions.setTip(deps.db, sid, target.value.prev_id)

    return c.json({ ok: true, undone: true }, 200)
  })
  .openapi(readRoute, async c => c.json({ ok: true }, 200))
  .openapi(stateRoute, async c => c.json({ status: 'idle', parts: [] }, 200))
  .openapi(mailboxRoute, async c => {
    const { db } = c.get('deps')
    const r = await Mailbox.list(db, c.req.valid('param').id)
    return r.isErr() ? err500(c, r.error) : c.json({ entries: r.value }, 200)
  })
  .openapi(changesRoute, async c => {
    const { db } = c.get('deps')
    const sid = c.req.valid('param').id
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
    return c.json({ changes }, 200)
  })
  .openapi(settingsRoute, async c => {
    const { db } = c.get('deps')
    const sid = c.req.valid('param').id
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
      : c.json({ session: sessionToJson(s.value) }, 200)
  })
  .openapi(interruptRoute, async c => {
    const deps = c.get('deps')
    const sid = c.req.valid('param').id
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
    return c.json({ interrupted: true }, 200)
  })

// SSE endpoints return a raw streaming Response, so they are registered as
// plain GET routes (the `.openapi()` path cannot express a stream response).
export const sessionRoutes = $(sessionOpenapi)
  .get('/sessions/:id/stream', sseHandler)
  .get('/sessions/:id/events', sseHandler)
