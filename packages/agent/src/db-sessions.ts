import type { SessionRow } from '@rucoder-agent/schema'
import { sql as dsql, eq } from 'drizzle-orm'
import type { ResultAsync } from 'neverthrow'
import type { Db } from './db-client.js'
import { nowStr, q } from './db-client.js'
import { mailbox, sessions } from './db-schema.js'

type Row = typeof sessions.$inferSelect

const toRow = (r: Row): SessionRow => ({
  name: r.name,
  org: r.org,
  repo: r.repo,
  branch: r.branch,
  model: r.model,
  preset: r.preset,
  tip_id: r.tipId,
  parent_id: r.parentId,
  fork_at_msg_id: r.forkAtMsgId,
  worker_url: r.workerUrl,
  container_id: r.containerId,
  max_turns: r.maxTurns,
  system_prompt: r.systemPrompt,
  revert: r.revert,
  redo_tip_id: r.redoTipId,
  last_read_at: r.lastReadAt,
  input_tokens: Number(r.inputTokens),
  output_tokens: Number(r.outputTokens),
  total_tokens: Number(r.totalTokens),
  created_at: r.createdAt,
  updated_at: r.updatedAt,
  last_used_at: r.lastUsedAt,
})

export interface SessionPatch {
  model?: string
  preset?: string
  maxTurns?: number
  systemPrompt?: string
}

export const Sessions = {
  list(db: Db): ResultAsync<SessionRow[], string> {
    return q(
      () =>
        db
          .select()
          .from(sessions)
          .orderBy(dsql`${sessions.updatedAt} DESC`)
          .then(rows => rows.map(toRow)),
      'list sessions',
    )
  },

  get(db: Db, name: string): ResultAsync<SessionRow | null, string> {
    return q(
      () =>
        db
          .select()
          .from(sessions)
          .where(eq(sessions.name, name))
          .limit(1)
          .then(rows => {
            const r = rows[0]
            return r === undefined ? null : toRow(r)
          }),
      'get session',
    )
  },

  create(
    db: Db,
    input: Pick<SessionRow, 'name' | 'org' | 'repo' | 'branch'> & {
      model?: string
      preset?: string
      parentName?: string | null
      tipId?: string | null
      forkAtMsgId?: string | null
      maxTurns?: number
      systemPrompt?: string
    },
  ): ResultAsync<string, string> {
    return q(
      () =>
        db.insert(sessions).values({
          name: input.name,
          org: input.org,
          repo: input.repo,
          branch: input.branch,
          model: input.model ?? '',
          preset: input.preset ?? '',
          parentId: input.parentName ?? null,
          tipId: input.tipId ?? null,
          forkAtMsgId: input.forkAtMsgId ?? null,
          maxTurns: input.maxTurns ?? null,
          systemPrompt: input.systemPrompt ?? null,
          createdAt: nowStr(),
          updatedAt: nowStr(),
        }),
      'create session',
    ).map(() => input.name)
  },

  delete(db: Db, name: string): ResultAsync<void, string> {
    return q(async () => {
      // COW-safe delete. Messages are session-agnostic: a session only points
      // at its chain head via `tip_id`. Forked children share the parent's
      // message rows, so deleting a session must never touch messages — only
      // its private mailbox queue and the session row itself.
      await db.delete(mailbox).where(eq(mailbox.sessionId, name))
      await db.delete(sessions).where(eq(sessions.name, name))
    }, 'delete session')
  },

  setModel(db: Db, name: string, model: string): ResultAsync<void, string> {
    return q(
      () =>
        db
          .update(sessions)
          .set({ model, updatedAt: nowStr() })
          .where(eq(sessions.name, name)),
      'set session model',
    ).map(() => undefined)
  },

  updateSettings(
    db: Db,
    name: string,
    patch: SessionPatch,
  ): ResultAsync<void, string> {
    return q(
      () =>
        db
          .update(sessions)
          .set(patchToDrizzle(patch, nowStr()))
          .where(eq(sessions.name, name)),
      'update session settings',
    ).map(() => undefined)
  },

  tip(db: Db, name: string): ResultAsync<string | null, string> {
    return q(
      () =>
        db
          .select({ tipId: sessions.tipId })
          .from(sessions)
          .where(eq(sessions.name, name))
          .limit(1)
          .then(rows => rows[0]?.tipId ?? null),
      'get session tip',
    )
  },

  setTip(
    db: Db,
    name: string,
    tipId: string | null,
  ): ResultAsync<void, string> {
    return q(
      () =>
        db
          .update(sessions)
          .set({ tipId, updatedAt: nowStr() })
          .where(eq(sessions.name, name)),
      'set session tip',
    ).map(() => undefined)
  },

  addUsage(
    db: Db,
    name: string,
    input: number,
    output: number,
  ): ResultAsync<void, string> {
    return q(
      () =>
        db.execute(
          dsql`UPDATE sessions SET
                 input_tokens = input_tokens + ${input},
                 output_tokens = output_tokens + ${output},
                 total_tokens = total_tokens + ${input + output},
                 last_used_at = ${nowStr()}
               WHERE name = ${name}`,
        ),
      'add session usage',
    ).map(() => undefined)
  },

  exists(db: Db, name: string): ResultAsync<boolean, string> {
    return q(
      () =>
        db
          .select({ name: sessions.name })
          .from(sessions)
          .where(eq(sessions.name, name))
          .limit(1)
          .then(rows => rows.length > 0),
      'session exists',
    )
  },
}

function patchToDrizzle(
  patch: SessionPatch,
  updatedAt: string,
): Partial<typeof sessions.$inferInsert> {
  const set: Partial<typeof sessions.$inferInsert> = { updatedAt }
  if (patch.model !== undefined) set.model = patch.model
  if (patch.preset !== undefined) set.preset = patch.preset
  if (patch.maxTurns !== undefined) set.maxTurns = patch.maxTurns
  if (patch.systemPrompt !== undefined) set.systemPrompt = patch.systemPrompt
  return set
}
