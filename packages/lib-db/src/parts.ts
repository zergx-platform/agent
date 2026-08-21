import type { PartRow } from '@rucoder-agent/schema'
import { eq } from 'drizzle-orm'
import type { ResultAsync } from 'neverthrow'
import type { Db } from './client.js'
import { q, uuid } from './client.js'
import { parts } from './schema.js'

const toRow = (r: typeof parts.$inferSelect): PartRow => ({
  id: r.id,
  message_id: r.messageId,
  session_id: r.sessionId,
  type: r.type,
  change_id: r.changeId,
  seq: r.seq,
  data: r.data,
})

export const Parts = {
  insert(
    db: Db,
    sessionId: string,
    messageId: string,
    type: string,
    seq: number,
    data: unknown,
    changeId: string | null = null,
  ): ResultAsync<string, string> {
    const id = uuid()
    return q(
      () =>
        db.insert(parts).values({
          id,
          sessionId,
          messageId,
          type,
          seq,
          changeId,
          data: JSON.stringify(data ?? {}),
        }),
      'insert part',
    ).map(() => id)
  },

  listBySession(db: Db, sessionId: string): ResultAsync<PartRow[], string> {
    return q(
      () =>
        db
          .select()
          .from(parts)
          .where(eq(parts.sessionId, sessionId))
          .orderBy(parts.messageId, parts.seq)
          .then(rows => rows.map(toRow)),
      'list parts',
    )
  },

  listByMessage(db: Db, messageId: string): ResultAsync<PartRow[], string> {
    return q(
      () =>
        db
          .select()
          .from(parts)
          .where(eq(parts.messageId, messageId))
          .orderBy(parts.seq)
          .then(rows => rows.map(toRow)),
      'list parts by message',
    )
  },
}
