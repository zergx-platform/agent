import type { MailboxRow } from '@rucoder-agent/schema'
import { sql as dsql, eq } from 'drizzle-orm'
import type { ResultAsync } from 'neverthrow'
import type { Db } from './db-client.js'
import { nowStr, q, rowsOf, uuid } from './db-client.js'
import { mailbox } from './db-schema.js'

const toRow = (r: typeof mailbox.$inferSelect): MailboxRow => ({
  id: r.id,
  session_name: r.sessionName,
  msg_type: r.msgType,
  payload: r.payload,
  effective_at: r.effectiveAt,
  status: r.status,
  created_at: r.createdAt,
  consumed_at: r.consumedAt,
  seq: r.seq,
})

export const Mailbox = {
  enqueue(
    db: Db,
    sessionName: string,
    msgType: string,
    payload: unknown,
  ): ResultAsync<string, string> {
    const id = uuid()
    return q(
      () =>
        db.insert(mailbox).values({
          id,
          sessionName,
          msgType,
          payload: JSON.stringify(payload ?? {}),
          status: 'pending',
          createdAt: nowStr(),
        }),
      'enqueue mailbox',
    ).map(() => id)
  },

  list(db: Db, sessionName: string): ResultAsync<MailboxRow[], string> {
    return q(
      () =>
        db
          .select()
          .from(mailbox)
          .where(eq(mailbox.sessionName, sessionName))
          .then(rows => rows.map(toRow)),
      'list mailbox',
    )
  },

  /** Sessions that still have pending mailbox items (startup recovery). */
  pendingSessions(db: Db): ResultAsync<string[], string> {
    return q(
      () =>
        db
          .execute(
            dsql`SELECT DISTINCT session_name FROM mailbox WHERE status = 'pending'`,
          )
          .then(res => rowsOf(res).map(r => String(r.session_name))),
      'pending sessions',
    )
  },

  /**
   * Atomically pop the next pending item (ordered). The UPDATE-with-subquery
   * keeps concurrent replicas from consuming the same row.
   */
  drainOne(
    db: Db,
    sessionName: string,
  ): ResultAsync<MailboxRow | null, string> {
    return q(
      () =>
        db
          .execute(
            dsql`UPDATE mailbox SET status = 'consumed', consumed_at = ${nowStr()}
               WHERE id = (
                 SELECT id FROM mailbox
                 WHERE session_name = ${sessionName} AND status = 'pending'
                 ORDER BY COALESCE(effective_at, created_at) ASC, COALESCE(seq, 0) ASC, created_at ASC
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED
               )
               RETURNING id, session_name, msg_type, payload, effective_at, status, created_at, consumed_at, seq`,
          )
          .then(res => {
            const rows = rowsOf(res)
            const r = rows[0]
            if (r === undefined) return null
            return {
              id: String(r.id),
              session_name: String(r.session_name),
              msg_type: String(r.msg_type),
              payload: String(r.payload),
              effective_at: (r.effective_at as string | null) ?? null,
              status: String(r.status),
              created_at: String(r.created_at),
              consumed_at: (r.consumed_at as string | null) ?? null,
              seq: (r.seq as number | null) ?? null,
            } satisfies MailboxRow
          }),
      'drain mailbox one',
    )
  },

  hasPendingInterrupt(
    db: Db,
    sessionName: string,
  ): ResultAsync<boolean, string> {
    return q(
      () =>
        db
          .execute(
            dsql`SELECT EXISTS(
                 SELECT 1 FROM mailbox
                 WHERE session_name = ${sessionName} AND msg_type = 'interrupt' AND status = 'pending'
               ) AS ok`,
          )
          .then(res => rowsOf(res)[0]?.ok === true),
      'has pending interrupt',
    )
  },
}
