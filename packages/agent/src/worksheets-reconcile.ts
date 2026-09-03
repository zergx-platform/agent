import { Agent as AbcAgent } from '@abc-protocol/sdk'
import type { AgentDeps } from './session-agent.js'
import { logger } from './logger.js'
import { Worksheets } from './db-worksheets.js'

/**
 * Worksheet dispatch reconciler: rows stuck in `dispatching` (agent crashed
 * between the CAS claim and the hook reply, or the replica died mid-request)
 * are re-dispatched to the owning extension. At-least-once dispatch is safe —
 * extensions dedupe by worksheet_id before executing side effects.
 */
export function watchWorksheetReconciler(
  deps: AgentDeps,
  intervalMs = 30_000,
  stuckAfterMs = 60_000,
): () => void {
  const timer = setInterval(() => void sweep(), intervalMs)
  timer.unref()
  const sweep = async (): Promise<void> => {
    const stuck = await Worksheets.listByStatus(deps.db, 'dispatching')
    if (stuck.isErr()) {
      logger.warn({ err: stuck.error }, 'worksheet reconcile: list failed')
      return
    }
    const cutoff = Date.now() - stuckAfterMs
    for (const w of stuck.value) {
      const decided = Date.parse(w.decided_at?.replace(' ', 'T') ?? '')
      if (Number.isNaN(decided) || decided > cutoff) continue
      await dispatchDecision(deps, w.id, w.session_name, w.ext_id, w.action, safeArgs(w.args), 'approve')
    }
  }
  return () => clearInterval(timer)
}

function safeArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return typeof v === 'object' && v !== null
      ? (v as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Shared dispatch path for the approve route and the reconciler: deliver the
 * decision to the owning extension via the worksheet-decided call hook and
 * resolve the row to a terminal state. Returns null on success or an error
 * message. `reject` never rolls back — there is nothing to re-execute.
 */
export async function dispatchDecision(
  deps: AgentDeps,
  id: string,
  sessionName: string,
  extId: string,
  action: string,
  args: Record<string, unknown>,
  decision: 'approve' | 'reject',
): Promise<string | null> {
  const agent = new AbcAgent(deps.bus)
  let hookError: string | null = null
  try {
    const res = await agent.callHook(sessionName, extId, 'worksheet-decided', {
      worksheet_id: id,
      action,
      decision,
      args,
      session: sessionName,
    })
    if (!res.ok) {
      hookError = res.error?.message ?? 'extension rejected the decision'
    }
  } catch (e) {
    hookError = String(e)
  }
  const terminal = await Worksheets.markTerminal(
    deps.db,
    id,
    decision === 'approve' ? 'dispatched' : 'rejected',
  )
  if (terminal.isErr()) {
    logger.warn({ id, err: terminal.error }, 'worksheet: terminal mark failed')
  }
  return hookError
}
