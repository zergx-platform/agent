/**
 * In-memory per-session abort controllers: the mid-stream interrupt signal.
 * The HTTP interrupt route (same replica) aborts directly; cross-replica
 * interrupts arrive via the durable mailbox wake signal, which the running
 * replica watches and forwards to the same controller.
 */
const controllers = new Map<string, AbortController>()

export function getAbortController(sid: string): AbortController {
  let ctrl = controllers.get(sid)
  if (ctrl === undefined || ctrl.signal.aborted) {
    ctrl = new AbortController()
    controllers.set(sid, ctrl)
  }
  return ctrl
}

export function interruptRun(sid: string): void {
  controllers.get(sid)?.abort()
}

export function clearRun(sid: string): void {
  controllers.delete(sid)
}

export function isAborted(sid: string): boolean {
  return controllers.get(sid)?.signal.aborted ?? false
}
