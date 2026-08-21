import type { MessageRow } from '@rucoder-agent/schema'
import { eq } from 'drizzle-orm'
import type { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type { Db } from './db-client.js'
import { nowStr, q, uuid } from './db-client.js'
import { messages } from './db-schema.js'

const toRow = (r: typeof messages.$inferSelect): MessageRow => ({
  id: r.id,
  role: r.role,
  content: r.content,
  parts_json: r.partsJson,
  prev_id: r.prevId,
  tool_name: r.toolName,
  tool_call_id: r.toolCallId,
  created_at: r.createdAt,
})

export interface ChainMessage extends MessageRow {}

export type MessageRole = 'user' | 'assistant' | 'event'

export const Messages = {
  insert(
    db: Db,
    role: MessageRole,
    content: string,
    prevId: string | null,
  ): ResultAsync<string, string> {
    const id = uuid()
    return q(
      () =>
        db.insert(messages).values({
          id,
          role,
          content,
          prevId,
          partsJson: '[]',
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
          SELECT id, role, content, parts_json, prev_id,
                 tool_name, tool_call_id, created_at, 0 AS depth
          FROM messages WHERE id = ${cursor}
          UNION
          SELECT m.id, m.role, m.content, m.parts_json, m.prev_id,
                 m.tool_name, m.tool_call_id, m.created_at,
                 c.depth + 1
          FROM messages m JOIN chain c ON m.id = c.prev_id
        )
        SELECT id, role, content, parts_json, prev_id,
               tool_name, tool_call_id, created_at
        FROM chain WHERE depth < ${limit}
        ORDER BY depth DESC`
      return ChainRowSchema.array().parse(rows).map(toChain)
    }, 'query message chain')
  },
}

/** Raw row shape returned by the recursive CTE (camel-cased via drizzle). */
const ChainRowSchema = z.object({
  id: z.string(),
  role: z.string(),
  content: z.string(),
  parts_json: z.string(),
  prev_id: z.string().nullable(),
  tool_name: z.string(),
  tool_call_id: z.string(),
  created_at: z.string(),
})

const toChain = (r: z.infer<typeof ChainRowSchema>): ChainMessage => ({
  id: r.id,
  role: r.role,
  content: r.content,
  parts_json: r.parts_json,
  prev_id: r.prev_id,
  tool_name: r.tool_name,
  tool_call_id: r.tool_call_id,
  created_at: r.created_at,
})
