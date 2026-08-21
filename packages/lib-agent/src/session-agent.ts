import type { Bus } from '@rucoder-agent/lib-bus'
import { mailboxSubject } from '@rucoder-agent/lib-bus'
import type { ServerConfig } from '@rucoder-agent/lib-config'
import {
  acquireSessionLock,
  type Db,
  Mailbox,
  Messages,
  Parts,
  Presets,
  parseJson,
  Sessions,
} from '@rucoder-agent/lib-db'
import type { LlmRegistry } from '@rucoder-agent/lib-llm'
import { isStepCount, type ModelMessage, streamText } from 'ai'
import type { Sql } from 'postgres'
import { events, pushEvent } from './events.js'
import { rebuildHistory } from './history.js'
import { clearRun, getAbortController, interruptRun } from './interrupt.js'
import { buildAiTools, discoverTools, type SessionCtx } from './tools.js'

export interface AgentDeps {
  db: Db
  sql: Sql
  bus: Bus
  config: ServerConfig
  llm: LlmRegistry
}

const LOCK_WAIT_MS = 2000
const DRAIN_GRACE_MS = 200

/**
 * Entry point per prompt/interrupt wake. Holds the session's cross-replica
 * advisory lock while draining the mailbox, so at most one replica runs a
 * session at a time.
 */
export async function runSessionTurn(
  deps: AgentDeps,
  sid: string,
): Promise<void> {
  const lockRes = await acquireSessionLock(deps.sql, sid, LOCK_WAIT_MS)
  if (lockRes.isErr()) {
    console.warn(`[agent] lock error (${sid}): ${lockRes.error}`)
    return
  }
  if (lockRes.value === null) {
    // Another replica is draining this session's mailbox.
    return
  }
  const lock = lockRes.value

  try {
    for (;;) {
      let item = await drainOne(deps, sid)
      if (item === null) {
        // Double-drain to close the enqueue/drain race.
        await sleep(DRAIN_GRACE_MS)
        item = await drainOne(deps, sid)
        if (item === null) break
      }

      if (item.msg_type === 'interrupt') {
        // Abort any in-flight run on this replica (cross-replica aborts go
        // through the wake-signal watcher inside the turn). Consuming the
        // item must not eat a subsequently queued prompt, so continue.
        interruptRun(sid)
        continue
      }

      if (item.msg_type === 'user_prompt') {
        const r = await runTurnOnce(deps, sid)
        if (r !== null) {
          pushEvent(deps.bus, sid, 'error', { message: r })
        }
        continue
      }

      // worker_event -> fold into history as a system message, continue.
      const payload = parseJson<{ content?: string }>(item.payload)
      const text = payload?.content ?? item.payload
      const tip = await Sessions.tip(deps.db, sid)
      const tipId = tip.isErr() ? null : tip.value
      const insert = await Messages.insert(deps.db, sid, 'system', text, tipId)
      if (insert.isOk()) {
        await Sessions.setTip(deps.db, sid, insert.value)
      }
    }
  } finally {
    await lock.release()
    pushEvent(deps.bus, sid, 'status', { type: 'idle' })
  }
}

async function drainOne(deps: AgentDeps, sid: string) {
  const r = await Mailbox.drainOne(deps.db, sid)
  return r.isErr() ? null : r.value
}

interface TurnStep {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
  toolResults: Array<{ toolCallId: string; toolName: string; output: unknown }>
}

/**
 * One user prompt → full agent turn: stream the model, persist each finished
 * step immediately, execute tools via the NATS bridge, feed results back —
 * bounded by maxTurns and abortable mid-stream.
 */
async function runTurnOnce(
  deps: AgentDeps,
  sid: string,
): Promise<string | null> {
  const sessionRes = await Sessions.get(deps.db, sid)
  if (sessionRes.isErr()) return sessionRes.error
  const session = sessionRes.value
  if (session === null) return 'session not found'

  const ctx: SessionCtx = {
    org: session.org,
    repo: session.repo,
    branch: session.branch,
  }

  const presetRow =
    session.preset !== ''
      ? (await Presets.get(deps.db, session.preset)).unwrapOr(null)
      : null
  const presetTools = parseJson<string[]>(presetRow?.tools ?? '[]') ?? []
  const whitelist = Array.isArray(presetTools) ? new Set(presetTools) : null

  const discovered = await discoverTools(deps.config.toolServers)
  const active =
    whitelist === null
      ? discovered
      : discovered.filter(t => whitelist.has(t.name))
  const tools = buildAiTools(active, ctx, deps.bus, deps.config.toolTimeoutMs)

  const messages = await loadHistory(deps, sid)

  const systemPrompt =
    session.system_prompt !== null && session.system_prompt !== ''
      ? session.system_prompt
      : presetRow !== null && presetRow.system_prompt !== ''
        ? presetRow.system_prompt
        : 'You are a helpful assistant.'
  const env = [
    '<env>',
    `  Session repo: ${ctx.org}/${ctx.repo}#${ctx.branch}`,
    '  This is the ONLY repo you may modify. Read access to all other platform repos: pass target="org/repo/bookmark".',
    `  Today's date: ${new Date().toISOString().slice(0, 10)}`,
    '</env>',
  ].join('\n')

  const maxTurns =
    session.max_turns !== null && session.max_turns > 0
      ? session.max_turns
      : presetRow !== null && presetRow.max_turns > 0
        ? presetRow.max_turns
        : deps.config.defaultMaxTurns

  const resolved = await deps.llm.resolve(deps.db, session.model)
  if (resolved.isErr()) return resolved.error

  const ctrl = getAbortController(sid)
  pushEvent(deps.bus, sid, 'status', { type: 'busy' })

  // Cross-replica mid-stream interrupt: watch the durable mailbox wake
  // signal while the turn is streaming.
  const wakeRes = await deps.bus.subscribe(mailboxSubject(sid))
  let watcher: Promise<void> | null = null
  if (wakeRes.isOk()) {
    const sub = wakeRes.value
    watcher = (async () => {
      for await (const m of sub) {
        try {
          const parsed = JSON.parse(Buffer.from(m.data).toString('utf8')) as {
            type?: string
          }
          if (parsed.type === 'interrupt') ctrl.abort()
        } catch {
          // ignore malformed wakeups
        }
      }
    })()
    watcher.catch(() => {})
    try {
      sub.drain()
    } catch {
      // best-effort
    }
  }

  let interrupted = false
  try {
    const result = streamText({
      model: resolved.value.model,
      system: `${systemPrompt}\n\n${env}`,
      messages,
      tools,
      temperature: deps.config.defaultTemperature,
      maxOutputTokens: deps.config.defaultMaxTokens,
      stopWhen: isStepCount(maxTurns),
      abortSignal: ctrl.signal,
      onChunk: ({ chunk }) => {
        if (chunk.type === 'text-delta') {
          pushEvent(deps.bus, sid, 'text-delta', { text: chunk.text })
        } else if (chunk.type === 'tool-result') {
          pushEvent(deps.bus, sid, 'tool-result', {
            tool_use_id: chunk.toolCallId,
            content: outputToContent(chunk.output),
          })
        }
      },
      onStepFinish: step => {
        void persistStep(deps, sid, step)
      },
    })

    try {
      await result.steps
      const usage = await result.totalUsage
      await Sessions.addUsage(
        deps.db,
        sid,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
      )
    } catch (e) {
      if (ctrl.signal.aborted) {
        interrupted = true
      } else {
        return `turn failed: ${String(e)}`
      }
    }
  } finally {
    if (watcher !== null && wakeRes.isOk()) {
      wakeRes.value.unsubscribe()
    }
    clearRun(sid)
  }

  pushEvent(deps.bus, sid, 'turn-complete', {
    reason: interrupted ? 'interrupted' : 'stop',
  })
  return null
}

/** Persist one finished step: chained assistant message + parts + tip. */
async function persistStep(
  deps: AgentDeps,
  sid: string,
  step: TurnStep,
): Promise<void> {
  const text = step.text ?? ''
  const outputs = new Map(step.toolResults.map(tr => [tr.toolCallId, tr]))
  if (text === '' && step.toolCalls.length === 0) return

  const tipRes = await Sessions.tip(deps.db, sid)
  const prevId = tipRes.isErr() ? null : tipRes.value
  const insert = await Messages.insert(deps.db, sid, 'assistant', text, prevId)
  if (insert.isErr()) {
    console.error(`[agent] persist step failed (${sid}): ${insert.error}`)
    return
  }
  const messageId = insert.value

  let seq = 0
  if (text !== '') {
    await Parts.insert(deps.db, sid, messageId, 'text', seq++, { text })
  }
  for (const tc of step.toolCalls) {
    const out = outputs.get(tc.toolCallId)?.output
    const changeId =
      out !== null &&
      out !== undefined &&
      typeof out === 'object' &&
      'result' in (out as Record<string, unknown>) &&
      (out as { result?: { change_id?: unknown } }).result !== null &&
      typeof (out as { result?: { change_id?: unknown } }).result === 'object'
        ? (((out as { result: { change_id?: unknown } }).result.change_id as
            | string
            | undefined) ?? null)
        : null
    await Parts.insert(
      deps.db,
      sid,
      messageId,
      'tool',
      seq++,
      { id: tc.toolCallId, name: tc.toolName, input: tc.input },
      changeId,
    )
    if (out !== undefined) {
      await Parts.insert(deps.db, sid, messageId, 'tool_result', seq++, {
        tool_use_id: tc.toolCallId,
        content: outputToContent(out),
      })
    }
  }
  await Sessions.setTip(deps.db, sid, messageId)
}

async function loadHistory(
  deps: AgentDeps,
  sid: string,
): Promise<ModelMessage[]> {
  const tipRes = await Sessions.tip(deps.db, sid)
  const tipId = tipRes.isErr() ? null : tipRes.value
  const chain = await Messages.chain(deps.db, sid, 100_000, null, tipId)
  const parts = await Parts.listBySession(deps.db, sid)
  if (chain.isErr() || parts.isErr()) return []
  return rebuildHistory(chain.value, parts.value)
}

function outputToContent(output: unknown): string {
  if (typeof output === 'string') return output
  if (
    output !== null &&
    typeof output === 'object' &&
    'content' in (output as Record<string, unknown>) &&
    typeof (output as { content: unknown }).content === 'string'
  ) {
    return (output as { content: string }).content
  }
  return JSON.stringify(output ?? '')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export { events }
