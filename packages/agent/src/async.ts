import { logger } from './logger.js'

/**
 * Fire-and-forget a bookkeeping promise (index updates, session var
 * projections, …) with a logged failure. Bare `void promise` would surface a
 * rejection as an unhandledRejection; this keeps the call non-blocking while
 * making the loss observable.
 */
export function fireAndForget(p: Promise<unknown>, op: string): void {
  p.catch(err => {
    logger.warn({ op, err: String(err) }, 'fire-and-forget operation failed')
  })
}
