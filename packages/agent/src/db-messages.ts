import type { MessageRow } from '@rucoder-agent/schema'
import { eq } from 'drizzle-orm'
import type { ResultAsync } from 'neverthrow'
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
        const bm = await db
          .select({ prevId: messages.prevId })
          .from(messages)
          .where(eq(messages.id, before))
          .limit(1)
        cursor = bm[0]?.prevId ?? null
      } else {
        // COW: the chain is walked purely on `prev_id`, starting from the
        // session's tip. A fork shares parent messages because its tip points
        // at the same message row (zero-copy fork).
        cursor = tipId
      }
      const chain: Row[] = []
      const visited = new Set<string>()
      while (cursor !== null && chain.length < limit && !visited.has(cursor)) {
        visited.add(cursor)
        const row = await db
          .select()
          .from(messages)
          .where(eq(messages.id, cursor))
          .limit(1)
        const found = row[0]
        if (found === undefined) break
        chain.push(found)
        cursor = found.prevId
      }
      return chain.reverse().map(toRow)
    }, 'query message chain')
  },
}

type Row = typeof messages.$inferSelect
