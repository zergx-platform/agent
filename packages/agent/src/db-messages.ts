import type { MessageRow } from '@rucoder-agent/schema'
import { eq, inArray } from 'drizzle-orm'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { Db } from './db-client.js'
import { nowStr, q, uuid } from './db-client.js'
import { messages, parts } from './db-schema.js'
import { parse, SummaryPartDataSchema, TextPartDataSchema } from './json.js'

const toRow = (r: typeof messages.$inferSelect): MessageRow => ({
  id: r.id,
  role: r.role,
  prev_id: r.prevId,
  tool_name: r.toolName,
  tool_call_id: r.toolCallId,
  created_at: r.createdAt,
})

export interface ChainMessage extends MessageRow {
  /** Pure-text view: text parts for normal messages, the summary for a
   *  compaction message (used by the read API/UI). */
  content: string
}

export type MessageRole = 'user' | 'assistant' | 'event' | 'compaction'

export const Messages = {
  insert(
    db: Db,
    role: MessageRole,
    prevId: string | null,
  ): ResultAsync<string, string> {
    const id = uuid()
    return q(
      () =>
        db.insert(messages).values({
          id,
          role,
          prevId,
          createdAt: nowStr(),
        }),
      'insert message',
    ).map(() => id)
  },

  get(db: Db, id: string): ResultAsync<MessageRow | null, string> {
    return q(
      () =>
        db
          .select()
          .from(messages)
          .where(eq(messages.id, id))
          .limit(1)
          .then(rows => {
            const r = rows[0]
            return r === undefined ? null : toRow(r)
          }),
      'get message',
    )
  },

  /** Messages for a set of ids, oldest-first by chain order (cache hit path). */
  byIds(db: Db, ids: string[]): ResultAsync<ChainMessage[], string> {
    if (ids.length === 0) {
      return ResultAsync.fromSafePromise(Promise.resolve<ChainMessage[]>([]))
    }
    return q(async () => {
      const rows = await db
        .select()
        .from(messages)
        .where(inArray(messages.id, ids))
      const byId = new Map(rows.map(r => [r.id, r]))
      const ordered = ids.flatMap(id => {
        const r = byId.get(id)
        return r === undefined ? [] : [toRow(r)]
      })
      const contentByMsg = await textContentByMessages(db, ids)
      return ordered.map(m => ({
        ...m,
        content: contentByMsg.get(m.id) ?? '',
      }))
    }, 'messages by ids')
  },

  /**
   * Walk the prev_id chain backwards from the tip (or from `before`'s
   * predecessor), newest → oldest, up to `limit`, then return oldest-first.
   *
   * Uses a single `WITH RECURSIVE` query instead of an N+1 loop: the whole
   * chain is pulled back in one round-trip. The recursive body joins on
   * `m.id = c.prev_id`, which is served by `idx_messages_prev` so each step
   * is an index scan. `UNION` (rather than `UNION ALL`) dedupes by row, which
   * also protects against a malformed `prev_id` cycle looping forever; `depth
   * < limit` additionally bounds the walk.
   *
   * Each row's `content` is derived by concatenating its text parts in `seq`
   * order — messages no longer carry an inline content column.
   */
  chain(
    db: Db,
    tipId: string | null,
    limit: number,
    before: string | null,
  ): ResultAsync<ChainMessage[], string> {
    return q(async () => {
      let cursor: string | null
      if (before !== null) {
        const bm = await db.$client`
          SELECT prev_id FROM messages WHERE id = ${before} LIMIT 1`
        cursor = bm[0]?.prev_id ?? null
      } else {
        // COW: the chain is walked purely on `prev_id`, starting from the
        // session's tip. A fork shares parent messages because its tip points
        // at the same message row (zero-copy fork).
        cursor = tipId
      }
      if (cursor === null) return []

      const rows = await db.$client`
        WITH RECURSIVE chain AS (
          SELECT id, role, prev_id, tool_name, tool_call_id, created_at,
                 0 AS depth
          FROM messages WHERE id = ${cursor}
          UNION
          SELECT m.id, m.role, m.prev_id, m.tool_name, m.tool_call_id,
                 m.created_at, c.depth + 1
          FROM messages m JOIN chain c ON m.id = c.prev_id
        )
        SELECT id, role, prev_id, tool_name, tool_call_id, created_at
        FROM chain WHERE depth < ${limit}
        ORDER BY depth DESC`
      const parsed = ChainRowSchema.array().parse(rows)
      const chainMsgs = parsed.map(toChain)

      // Derive content from text parts for the chain's message ids.
      const ids = chainMsgs.map(m => m.id)
      const contentByMsg = await textContentByMessages(db, ids)

      return chainMsgs.map(m => ({
        ...m,
        content: contentByMsg.get(m.id) ?? '',
      }))
    }, 'query message chain')
  },
}

/** Raw row shape returned by the recursive CTE (camel-cased via drizzle). */
const ChainRowSchema = z.object({
  id: z.string(),
  role: z.string(),
  prev_id: z.string().nullable(),
  tool_name: z.string(),
  tool_call_id: z.string(),
  created_at: z.string(),
})

const toChain = (r: z.infer<typeof ChainRowSchema>): ChainMessage => ({
  id: r.id,
  role: r.role,
  content: '',
  prev_id: r.prev_id,
  tool_name: r.tool_name,
  tool_call_id: r.tool_call_id,
  created_at: r.created_at,
})

/** Message id → concatenated text parts (seq order). */
async function textContentByMessages(
  db: Db,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const rows = await db
    .select()
    .from(parts)
    .where(inArray(parts.messageId, ids))
    .orderBy(parts.messageId, parts.seq)
  for (const p of rows) {
    if (p.type === 'text') {
      const d = parse(TextPartDataSchema, p.data)
      if (d.isOk()) {
        out.set(p.messageId, (out.get(p.messageId) ?? '') + d.value.text)
      }
    } else if (p.type === 'summary') {
      const d = parse(SummaryPartDataSchema, p.data)
      if (d.isOk()) out.set(p.messageId, d.value.summary)
    }
  }
  return out
}
