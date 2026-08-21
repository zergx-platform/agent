import type { MessageRow } from '@rucoder-agent/schema'
import { eq } from 'drizzle-orm'
import type { ResultAsync } from 'neverthrow'
import type { Db } from './client.js'
import { nowStr, q, uuid } from './client.js'
import { messages } from './schema.js'

const toRow = (r: typeof messages.$inferSelect): MessageRow => ({
  id: r.id,
  session_id: r.sessionId,
  role: r.role,
  content: r.content,
  parts_json: r.partsJson,
  prev_id: r.prevId,
  tool_name: r.toolName,
  tool_call_id: r.toolCallId,
  created_at: r.createdAt,
})

export interface ChainMessage extends MessageRow {}

export const Messages = {
  insert(
    db: Db,
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    prevId: string | null,
  ): ResultAsync<string, string> {
    const id = uuid()
    return q(
      () =>
        db.insert(messages).values({
          id,
          sessionId,
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
    sessionId: string,
    limit: number,
    before: string | null,
    tipId: string | null,
  ): ResultAsync<ChainMessage[], string> {
    void sessionId // chain is walked by id; kept for API symmetry
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

  /**
   * Delete `targetId` and every message after it in the chain. Returns the
   * removed ids (in chain order). The new tip becomes the target's prev_id,
   * which the caller sets.
   */
  deleteAfter(
    db: Db,
    sessionId: string,
    targetId: string,
  ): ResultAsync<string[], string> {
    return q(async () => {
      const rows = await db
        .select({ id: messages.id, prevId: messages.prevId })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
      const byPrev = new Map<string, string>()
      for (const r of rows) {
        if (r.prevId !== null) byPrev.set(r.prevId, r.id)
      }
      const removed: string[] = []
      let cursor: string | null = targetId
      while (cursor !== null) {
        removed.push(cursor)
        cursor = byPrev.get(cursor) ?? null
      }
      for (const id of removed) {
        await db.delete(messages).where(eq(messages.id, id))
      }
      return removed
    }, 'delete messages after')
  },
}

type Row = typeof messages.$inferSelect
