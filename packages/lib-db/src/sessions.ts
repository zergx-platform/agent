import type { SessionRow } from '@rucoder-agent/schema'
import { and, sql as dsql, eq } from 'drizzle-orm'
import type { ResultAsync } from 'neverthrow'
import type { Db } from './client.js'
import { nowStr, q, uuid } from './client.js'
import { sessions } from './schema.js'

type Row = typeof sessions.$inferSelect

const toRow = (r: Row): SessionRow => ({
  id: r.id,
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

  get(db: Db, id: string): ResultAsync<SessionRow | null, string> {
    return q(
      () =>
        db
          .select()
          .from(sessions)
          .where(eq(sessions.id, id))
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
    input: Pick<SessionRow, 'org' | 'repo' | 'branch'> & {
      model?: string
      preset?: string
      parentId?: string
      forkAtMsgId?: string
      maxTurns?: number
      systemPrompt?: string
    },
  ): ResultAsync<string, string> {
    const id = uuid()
    return q(
      () =>
        db.insert(sessions).values({
          id,
          org: input.org,
          repo: input.repo,
          branch: input.branch,
          model: input.model ?? '',
          preset: input.preset ?? '',
          parentId: input.parentId ?? null,
          forkAtMsgId: input.forkAtMsgId ?? null,
          maxTurns: input.maxTurns ?? null,
          systemPrompt: input.systemPrompt ?? null,
          createdAt: nowStr(),
          updatedAt: nowStr(),
        }),
      'create session',
    ).map(() => id)
  },

  delete(db: Db, id: string): ResultAsync<void, string> {
    return q(
      () => db.delete(sessions).where(eq(sessions.id, id)),
      'delete session',
    ).map(() => undefined)
  },

  setModel(db: Db, id: string, model: string): ResultAsync<void, string> {
    return q(
      () =>
        db
          .update(sessions)
          .set({ model, updatedAt: nowStr() })
          .where(eq(sessions.id, id)),
      'set session model',
    ).map(() => undefined)
  },

  updateSettings(
    db: Db,
    id: string,
    patch: SessionPatch,
  ): ResultAsync<void, string> {
    const set: Record<string, string | number | null> = {
      updated_at: nowStr(),
    }
    if (patch.model !== undefined) set.model = patch.model
    if (patch.preset !== undefined) set.preset = patch.preset
    if (patch.maxTurns !== undefined) set.max_turns = patch.maxTurns
    if (patch.systemPrompt !== undefined) set.system_prompt = patch.systemPrompt
    return q(
      () =>
        db
          .update(sessions)
          .set(patchToDrizzle(patch, nowStr()))
          .where(eq(sessions.id, id)),
      'update session settings',
    ).map(() => undefined)
  },

  tip(db: Db, id: string): ResultAsync<string | null, string> {
    return q(
      () =>
        db
          .select({ tipId: sessions.tipId })
          .from(sessions)
          .where(eq(sessions.id, id))
          .limit(1)
          .then(rows => rows[0]?.tipId ?? null),
      'get session tip',
    )
  },

  setTip(db: Db, id: string, tipId: string | null): ResultAsync<void, string> {
    return q(
      () =>
        db
          .update(sessions)
          .set({ tipId, updatedAt: nowStr() })
          .where(eq(sessions.id, id)),
      'set session tip',
    ).map(() => undefined)
  },

  addUsage(
    db: Db,
    id: string,
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
               WHERE id = ${id}`,
        ),
      'add session usage',
    ).map(() => undefined)
  },

  existsWithKey(
    db: Db,
    org: string,
    repo: string,
    branch: string,
  ): ResultAsync<boolean, string> {
    return q(
      () =>
        db
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.org, org),
              eq(sessions.repo, repo),
              eq(sessions.branch, branch),
            ),
          )
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
