import { zValidator } from '@hono/zod-validator'
import { interruptRun, runSessionTurn } from '@rucoder-agent/lib-agent'
import { mailboxSubject, STREAM_SSE, sseSubject } from '@rucoder-agent/lib-bus'
import {
  Mailbox,
  Messages,
  Parts,
  parseJson,
  Sessions,
} from '@rucoder-agent/lib-db'
import {
  CreateSessionBodySchema,
  ForkBodySchema,
  ModelBodySchema,
  PromptBodySchema,
  type SessionRow,
  SessionSettingsBodySchema,
  UndoBodySchema,
} from '@rucoder-agent/schema'
import { type Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { type AppEnv, EidDedup } from '../context.js'

/** Serialize a session row into the recoder UI contract. */
function sessionToJson(s: SessionRow): Record<string, unknown> {
  return { ...s, base_image: null, unread: 0 }
}

function err500(c: Context, message: string) {
  return c.json({ ok: false, error: message }, 500)
}

export const sessionRoutes = new Hono<AppEnv>()

sessionRoutes.get('/', async c => {
  const { db } = c.get('deps')
  const r = await Sessions.list(db)
  return r.isErr()
    ? err500(c, r.error)
    : c.json({ sessions: r.value.map(sessionToJson) })
})

sessionRoutes.post(
  '/',
  zValidator('json', CreateSessionBodySchema),
  async c => {
    const { db } = c.get('deps')
    const b = c.req.valid('json')
    const exists = await Sessions.existsWithKey(db, b.org, b.repo, b.branch)
    if (exists.isErr()) return err500(c, exists.error)
    if (exists.value) {
      return c.json({ ok: false, error: 'Session already exists' }, 409)
    }
    const id = await Sessions.create(db, b)
    return id.isErr()
      ? err500(c, id.error)
      : c.json({ ok: true, session_id: id.value })
  },
)

sessionRoutes.get('/:id', async c => {
  const { db } = c.get('deps')
  const r = await Sessions.get(db, c.req.param('id'))
  if (r.isErr()) return err500(c, r.error)
  return r.value === null
    ? c.json({ ok: false, error: 'session not found' }, 404)
    : c.json({ session: sessionToJson(r.value) })
})

sessionRoutes.delete('/:id', async c => {
  const { db } = c.get('deps')
  const id = c.req.param('id')
  interruptRun(id)
  const r = await Sessions.delete(db, id)
  return r.isErr() ? err500(c, r.error) : c.json({ ok: true })
})

sessionRoutes.get('/:id/messages', async c => {
  const { db } = c.get('deps')
  const sid = c.req.param('id')
  const limit = Number.parseInt(c.req.query('limit') ?? '50', 10)
  const before = c.req.query('before') ?? null
  const tipRes = await Sessions.tip(db, sid)
  const tipId = tipRes.isErr() ? null : tipRes.value
  const r = await Messages.chain(db, sid, limit, before, tipId)
  return r.isErr() ? err500(c, r.error) : c.json({ messages: r.value })
})

sessionRoutes.post(
  '/:id/prompt',
  zValidator('json', PromptBodySchema),
  async c => {
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
    const insert = await Messages.insert(deps.db, sid, 'user', prompt, tipId)
    if (insert.isErr()) return err500(c, insert.error)
    await Sessions.setTip(deps.db, sid, insert.value)

    const enq = await Mailbox.enqueue(deps.db, sid, 'user_prompt', {
      text: prompt,
    })
    if (enq.isErr()) return err500(c, enq.error)

    // Durable wake signal (any replica may pick the turn up via the lock).
    void deps.bus
      .publishStream(mailboxSubject(sid), {
        type: 'user_prompt',
        session_id: sid,
      })
      .then(() => undefined)

    void runSessionTurn(deps, sid).catch(e =>
      console.error(`[agent] turn crashed (${sid}): ${String(e)}`),
    )
    return c.json({ ok: true })
  },
)

// ---- SSE: durable JetStream replay + live, deduped by eid ----

async function sseHandler(c: Context<AppEnv>): Promise<Response> {
  const { bus } = c.get('deps')
  const sid = c.req.param('id') as string
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
      for (const v of replay.value as { eid?: string }[]) {
        dedup.mark(v.eid)
        await stream.writeSSE({ data: JSON.stringify(v) })
      }
    }

    for await (const m of sub) {
      if (closed) break
      let v: { eid?: string } | null = null
      try {
        v = JSON.parse(Buffer.from(m.data).toString('utf8'))
      } catch {
        continue
      }
      if (dedup.duplicate(v?.eid)) continue
      await stream.writeSSE({ data: JSON.stringify(v) })
    }
  }) as Response
}

sessionRoutes.get('/:id/stream', sseHandler)
sessionRoutes.get('/:id/events', sseHandler)

sessionRoutes.get('/:id/todos', async c => {
  const deps = c.get('deps')
  const url = `${deps.config.memoryUrl.replace(/\/$/, '')}/api/v1/todos?session_id=${c.req.param('id')}`
  try {
    const res = await fetch(url)
    return c.json(await res.json())
  } catch (e) {
    return err500(c, `memory service: ${String(e)}`)
  }
})

sessionRoutes.post('/:id/fork', zValidator('json', ForkBodySchema), async c => {
  const deps = c.get('deps')
  const pid = c.req.param('id')
  const b = c.req.valid('json')
  const parent = await Sessions.get(deps.db, pid)
  if (parent.isErr()) return err500(c, parent.error)
  if (parent.value === null) {
    return c.json({ ok: false, error: 'session not found' }, 404)
  }
  const p = parent.value

  const newId = crypto.randomUUID()
  const newBranch =
    b.branch && b.branch !== '' ? b.branch : `fork-${newId.slice(0, 8)}`

  // Copy the jj bookmark via repo-manager (best-effort, warn on failure).
  try {
    await fetch(
      `${deps.config.repoManagerUrl.replace(/\/$/, '')}/api/v1/repos/bookmark-from`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          org: p.org,
          repo: p.repo,
          source_branch: p.branch,
          new_branch: newBranch,
        }),
      },
    )
  } catch (e) {
    console.warn(`[agent] bookmark-from failed (${pid}): ${String(e)}`)
  }

  const id = await Sessions.create(deps.db, {
    org: p.org,
    repo: p.repo,
    branch: newBranch,
    model: p.model,
    preset: p.preset,
    parentId: p.id,
    forkAtMsgId: p.tip_id ?? undefined,
    maxTurns: p.max_turns ?? undefined,
    systemPrompt: p.system_prompt ?? undefined,
  })
  return id.isErr()
    ? err500(c, id.error)
    : c.json({ ok: true, session_id: id.value })
})

sessionRoutes.post(
  '/:id/model',
  zValidator('json', ModelBodySchema),
  async c => {
    const { db } = c.get('deps')
    const r = await Sessions.setModel(
      db,
      c.req.param('id'),
      c.req.valid('json').model,
    )
    return r.isErr()
      ? err500(c, r.error)
      : c.json({ model: c.req.valid('json').model })
  },
)

sessionRoutes.post('/:id/undo', zValidator('json', UndoBodySchema), async c => {
  const deps = c.get('deps')
  const sid = c.req.param('id')
  const { message_id } = c.req.valid('json')

  const session = await Sessions.get(deps.db, sid)
  if (session.isErr()) return err500(c, session.error)
  const s = session.value
  if (s === null) return c.json({ ok: false, error: 'session not found' }, 404)

  const tip = s.tip_id
  if (tip === null || tip === '') {
    return c.json({ ok: false, undone: false })
  }
  const targetId = message_id ?? tip
  const target = await Messages.get(deps.db, targetId)
  if (target.isErr()) return err500(c, target.error)
  if (target.value === null) return c.json({ ok: false, undone: false })

  const removed = await Messages.deleteAfter(deps.db, sid, targetId)
  if (removed.isErr()) return err500(c, removed.error)
  await Sessions.setTip(deps.db, sid, target.value.prev_id)

  // Roll back the jj working-copy change (best-effort).
  try {
    await fetch(
      `${deps.config.repoManagerUrl.replace(/\/$/, '')}/api/v1/git-undo`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ org: s.org, repo: s.repo, branch: s.branch }),
      },
    )
  } catch (e) {
    console.warn(`[agent] git-undo failed (${sid}): ${String(e)}`)
  }

  return c.json({ ok: true, undone: true, deleted: removed.value.length })
})

sessionRoutes.post('/:id/redo', async c => c.json({ ok: true, redone: false }))

sessionRoutes.post('/:id/read', async c => c.json({ ok: true }))

sessionRoutes.get('/:id/state', async c =>
  c.json({ status: 'idle', parts: [] }),
)

sessionRoutes.get('/:id/mailbox', async c => {
  const { db } = c.get('deps')
  const r = await Mailbox.list(db, c.req.param('id'))
  return r.isErr() ? err500(c, r.error) : c.json({ entries: r.value })
})

sessionRoutes.get('/:id/changes', async c => {
  const { db } = c.get('deps')
  const sid = c.req.param('id')
  const partsRes = await Parts.listBySession(db, sid)
  if (partsRes.isErr()) return err500(c, partsRes.error)

  const changes: Array<Record<string, unknown>> = []
  for (const p of partsRes.value) {
    if (p.type !== 'tool' || p.change_id === null) continue
    const data = parseJson<{ name?: string; content?: string }>(p.data) ?? {}
    changes.push({
      change_id: p.change_id,
      tool_name: data.name ?? 'tool',
      timestamp: '',
      message_id: p.message_id,
      content: (data.content ?? '').slice(0, 200),
      seq: p.seq,
    })
  }
  return c.json({ changes })
})

sessionRoutes.patch(
  '/:id/settings',
  zValidator('json', SessionSettingsBodySchema),
  async c => {
    const { db } = c.get('deps')
    const sid = c.req.param('id')
    const b = c.req.valid('json')
    const r = await Sessions.updateSettings(db, sid, {
      model: b.model,
      preset: b.preset,
      maxTurns: b.max_turns,
      systemPrompt: b.system_prompt,
    })
    if (r.isErr()) return err500(c, r.error)
    const s = await Sessions.get(db, sid)
    if (s.isErr()) return err500(c, s.error)
    return s.value === null
      ? c.json({ ok: false, error: 'session not found' }, 404)
      : c.json({ session: sessionToJson(s.value) })
  },
)

sessionRoutes.post('/:id/interrupt', async c => {
  const deps = c.get('deps')
  const sid = c.req.param('id')
  // 1. Local mid-stream abort (this replica).
  interruptRun(sid)
  // 2. Durable: enqueue + wake publish so the replica holding the session
  //    lock aborts its in-flight stream.
  const enq = await Mailbox.enqueue(deps.db, sid, 'interrupt', {})
  if (enq.isErr()) return err500(c, enq.error)
  void deps.bus
    .publishStream(mailboxSubject(sid), {
      type: 'interrupt',
      session_id: sid,
    })
    .then(() => undefined)
  void runSessionTurn(deps, sid).catch(e =>
    console.error(`[agent] interrupt drain crashed (${sid}): ${String(e)}`),
  )
  return c.json({ interrupted: true })
})
