import { ResultAsync } from 'neverthrow'
import type { Sql } from 'postgres'

export interface LockHandle {
  /** Roll back the transaction (releasing the advisory lock) and free the client. */
  release(): Promise<void>
}

/**
 * Session-scoped cross-replica mutual exclusion. Takes a Postgres advisory
 * TRANSACTION lock on a dedicated reserved connection, using raw BEGIN /
 * ROLLBACK so the lock can be held across an arbitrarily long mailbox drain
 * (postgres.js's callback-style transactions can't span that). The lock dies
 * with the connection, so a crashed replica releases it automatically.
 *
 * Returns null when another replica still holds the lock after `maxWaitMs`
 * (that replica is draining the mailbox; skipping is correct).
 */
export function acquireSessionLock(
  sql: Sql,
  sessionId: string,
  maxWaitMs = 2000,
): ResultAsync<LockHandle | null, string> {
  const sleep = (ms: number) =>
    new Promise<void>(resolve => setTimeout(resolve, ms))

  return ResultAsync.fromPromise(
    (async (): Promise<LockHandle | null> => {
      const deadline = Date.now() + maxWaitMs
      for (;;) {
        const client = await sql.reserve()
        try {
          await client`BEGIN`
          const rows: Array<{ ok: boolean }> =
            await client`SELECT pg_try_advisory_xact_lock(hashtext(${sessionId})) AS ok`
          if (rows[0]?.ok === true) {
            return {
              release: async () => {
                try {
                  await client`ROLLBACK`
                } catch {
                  // transaction already broken; the lock died with it
                } finally {
                  client.release()
                }
              },
            }
          }
          await client`ROLLBACK`
          client.release()
        } catch (e) {
          client.release()
          throw e
        }
        if (Date.now() >= deadline) return null
        await sleep(50)
      }
    })(),
    e => `acquire session lock: ${String(e)}`,
  )
}
