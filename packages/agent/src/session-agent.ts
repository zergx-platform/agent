import type { ModelMessage, Tool } from 'ai'
import { streamText } from 'ai'
import type { Sql } from 'postgres'
import { z } from 'zod'
import type { Bus } from './bus.js'
import { mailboxSubject } from './bus.js'
import type { ServerConfig } from './config.js'
import type { Db } from './db-client.js'
import { Presets } from './db-kv.js'
import { Mailbox } from './db-mailbox.js'
import { Messages } from './db-messages.js'
import { Parts } from './db-parts.js'
import { Sessions } from './db-sessions.js'
import { events, pushEvent } from './events.js'
import { renderTemplate } from './extensions.js'
import { rebuildHistory } from './history.js'
import { clearRun, getAbortController, interruptRun } from './interrupt.js'
import {
  ContentPayloadSchema,
  parse,
  type ToolResult,
  WakePayloadSchema,
} from './json.js'
import type { LlmRegistry } from './llm.js'
import { buildAiTools, discoverTools } from './tools.js'

export interface AgentDeps {
  db: Db
  sql: Sql
  bus: Bus
  config: ServerConfig
  llm: LlmRegistry
}

const DRAIN_GRACE_MS = 200

/**
 * Watch every session's mailbox wake wildcard and, for each arrival, attempt
 * an idempotent claim of that session's run lease. Because `runSessionTurn`
 * claims atomically and the losers return immediately, this lets any replica
 * pick up work for any session — the basis for horizontal scale-out.
 *
 * Returns an unsubscribe function.
 */
export function watchMailboxWake(deps: AgentDeps): () => void {
  let stopped = false
  let unsubscribe: (() => void) | null = null
  void deps.bus.subscribeMailboxWake().match(
    async sub => {
      unsubscribe = () => sub.unsubscribe()
      for await (const m of sub) {
        if (stopped) break
        const parsed = parse(WakePayloadSchema, m.data)
        if (parsed.isOk() && parsed.value.session_name !== '') {
          void runSessionTurn(deps, parsed.value.session_name)
        }
      }
    },
    err => {
      console.error(`[agent] mailbox wake subscribe failed: ${err}`)
    },
  )
  return () => {
    stopped = true
    unsubscribe?.()
  }
}

/**
 * Claim the per-session run lease (cross-replica), drain the mailbox to
 * completion, then release. The loop re-claims after releasing whenever a
 * final drain still finds work, closing the race where a message arrives just
 * as the lease is released. The durable wake signal remains as a cold-start
 * backstop; exactly one replica wins any given claim.
 */
export async function runSessionTurn(
  deps: AgentDeps,
  sid: string,
): Promise<void> {
  for (;;) {
    const claimed = await deps.bus.claimSession(sid)
    if (claimed.isErr()) {
      console.warn(`[agent] claim error (${sid}): ${claimed.error}`)
      return
    }
    if (claimed.value === false) {
      // Another replica is running this session; it will drain our message.
      return
    }

    try {
      for (;;) {
        const item = await drainOne(deps, sid)
        if (item === null) {
          // Re-drain after a short grace to close the enqueue/drain race.
          await sleep(DRAIN_GRACE_MS)
          const again = await drainOne(deps, sid)
          if (again === null) break
          await handleItem(deps, sid, again)
          continue
        }
        await handleItem(deps, sid, item)
      }
    } finally {
      await deps.bus.releaseSession(sid)
    }

    // Released: confirm nothing arrived during the release window. If it did,
    // loop and re-claim (the lease is now free, so the claim wins).
    const leftover = await drainOne(deps, sid)
    if (leftover === null) break
    await handleItem(deps, sid, leftover)
  }
  pushEvent(deps.bus, sid, 'status', { type: 'idle' })
}

async function handleItem(
  deps: AgentDeps,
  sid: string,
  item: { msg_type: string; payload: string },
): Promise<void> {
  if (item.msg_type === 'interrupt') {
    // Interrupt is handled out-of-band by the wake watcher; ignore here.
    interruptRun(sid)
    return
  }

  if (item.msg_type === 'user_prompt') {
    const r = await runTurnOnce(deps, sid)
    if (r !== null) {
      pushEvent(deps.bus, sid, 'error', { message: r })
    }
    return
  }

  // Everything else is an event: fold into the chain so it reaches the model.
  await persistEvent(deps, sid, item.payload)
}

async function drainOne(deps: AgentDeps, sid: string) {
  const r = await Mailbox.drainOne(deps.db, sid)
  return r.isErr() ? null : r.value
}

interface TurnCtx {
  tools: Record<string, Tool>
  system: string
  maxTurns: number
  resolvedModel: string
  model: import('ai').LanguageModel
}

/**
 * One user prompt → full agent turn. We drive AI SDK's `fullStream` ourselves
 * (no `stopWhen`) so each step boundary is an opportunity to drain the mailbox
 * for interrupts or freshly-arrived events, and to cap the step count.
 */
async function runTurnOnce(
  deps: AgentDeps,
  sid: string,
): Promise<string | null> {
  const prepared = await prepare(deps, sid)
  if (typeof prepared === 'string') return prepared
  const { tools, system, maxTurns, model } = prepared

  const ctrl = getAbortController(sid)
  pushEvent(deps.bus, sid, 'status', { type: 'busy' })

  // Cross-replica mid-stream interrupt: watch the durable mailbox wake signal.
  const wakeRes = await deps.bus.subscribe(mailboxSubject(sid))
  let unsub: (() => void) | null = null
  if (wakeRes.isOk()) {
    const sub = wakeRes.value
    unsub = () => {
      const un = (sub as { unsubscribe?: () => void }).unsubscribe
      un?.call(sub)
    }
    void (async () => {
      for await (const m of sub) {
        const parsed = parse(WakePayloadSchema, m.data)
        if (parsed.isOk() && parsed.value.type === 'interrupt') ctrl.abort()
      }
    })()
    const drain = (sub as { drain?: () => void }).drain
    drain?.call(sub)
  }

  let messages = await loadHistory(deps, sid)
  let interrupted = false
  let finished = false
  let step = 0

  try {
    while (step < maxTurns && !ctrl.signal.aborted) {
      const result = streamText({
        model,
        system,
        messages,
        tools,
        temperature: deps.config.defaultTemperature,
        maxOutputTokens: deps.config.defaultMaxTokens,
        abortSignal: ctrl.signal,
        maxRetries: 0,
      })

      let text = ''
      const toolCalls: Array<{
        id: string
        name: string
        input: unknown
      }> = []
      const toolResults: Array<{
        id: string
        name: string
        result: ToolResult
      }> = []
      let usage: { inputTokens: number; outputTokens: number } | null = null

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            text += part.text
            pushEvent(deps.bus, sid, 'text-delta', { text: part.text })
            break
          case 'tool-call':
            toolCalls.push({
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
            })
            break
          case 'tool-result':
            toolResults.push({
              id: part.toolCallId,
              name: part.toolName,
              result: part.output,
            })
            pushEvent(deps.bus, sid, 'tool-result', {
              tool_use_id: part.toolCallId,
              content: part.output.content,
            })
            break
          case 'tool-error':
            // A tool that failed/aborted still pairs with its call id so the
            // provider never sees a dangling tool-call.
            toolResults.push({
              id: part.toolCallId,
              name: part.toolName,
              result: { content: String(part.error), metadata: null },
            })
            pushEvent(deps.bus, sid, 'tool-result', {
              tool_use_id: part.toolCallId,
              content: String(part.error),
            })
            break
          case 'tool-output-denied':
            toolResults.push({
              id: part.toolCallId,
              name: part.toolName,
              result: { content: 'denied', metadata: null },
            })
            break
          case 'finish-step':
            usage = {
              inputTokens: part.usage.inputTokens ?? 0,
              outputTokens: part.usage.outputTokens ?? 0,
            }
            break
          case 'finish':
            finished = true
            break
          case 'error':
            return `turn failed: ${String((part as { error: unknown }).error)}`
          case 'abort':
            interrupted = true
            break
          default:
            break
        }
      }

      // Persist this step (text + fully-paired tool calls/results) and advance
      // the chain tip before considering the next iteration.
      await persistStep(deps, sid, text, toolCalls, toolResults)
      if (usage !== null) {
        await Sessions.addUsage(
          deps.db,
          sid,
          usage.inputTokens,
          usage.outputTokens,
        )
      }

      step += 1
      if (interrupted || ctrl.signal.aborted) break

      // Step boundary: inject any newly-arrived mailbox messages. A fresh
      // user_prompt continues the loop (the model responds to it); events fold
      // into context; a full stop with nothing new ends the turn.
      const injectedUserPrompt = await drainAndInject(deps, sid, ctrl)
      if (ctrl.signal.aborted && injectedUserPrompt.length === 0) break

      if (
        finished &&
        toolCalls.length === 0 &&
        injectedUserPrompt.length === 0
      ) {
        // Model stopped on its own and nothing new arrived.
        break
      }

      // Carry this step forward into the next iteration's message list.
      messages = appendStep(messages, text, toolCalls, toolResults)
      if (injectedUserPrompt.length > 0) {
        messages.push({
          role: 'user',
          content: injectedUserPrompt.join('\n'),
        })
      }
    }
  } finally {
    if (unsub !== null) unsub()
    clearRun(sid)
  }

  pushEvent(deps.bus, sid, 'turn-complete', {
    reason: interrupted ? 'interrupted' : 'stop',
  })
  return null
}

async function prepare(
  deps: AgentDeps,
  sid: string,
): Promise<TurnCtx | string> {
  const sessionRes = await Sessions.get(deps.db, sid)
  if (sessionRes.isErr()) return sessionRes.error
  const session = sessionRes.value
  if (session === null) return 'session not found'

  const presetRow =
    session.preset !== ''
      ? (await Presets.get(deps.db, session.preset)).unwrapOr(null)
      : null
  const presetTools = parse(z.array(z.string()), presetRow?.tools ?? '[]')
  const toolNames = presetTools.isOk() ? presetTools.value : []
  const whitelist = toolNames.length > 0 ? new Set(toolNames) : null

  const discovered = await discoverTools(deps.bus)
  const active =
    whitelist === null
      ? discovered
      : discovered.filter(t => whitelist.has(t.name))
  const tools = buildAiTools(active, deps.bus, deps.config.toolTimeoutMs, sid)

  const systemPrompt =
    presetRow !== null && presetRow.system_prompt !== ''
      ? presetRow.system_prompt
      : 'You are a helpful assistant.'
  const env = [
    '<env>',
    `  Today's date: ${new Date().toISOString().slice(0, 10)}`,
    '</env>',
  ].join('\n')

  // Render extension-provided template variables ({{ext.<id>.<name>}}) and
  // built-ins ({{date}}/{{datetime}}) into the system prompt. Unresolvable
  // variables are left as literal placeholders.
  const renderedPrompt = await renderTemplate(systemPrompt, deps.bus)

  const maxTurns =
    presetRow !== null && presetRow.max_turns > 0
      ? presetRow.max_turns
      : deps.config.defaultMaxTurns

  const resolved = await deps.llm.resolve(deps.db, session.model)
  if (resolved.isErr()) return resolved.error

  return {
    tools,
    system: `${renderedPrompt}\n\n${env}`,
    maxTurns,
    resolvedModel: resolved.value.modelId,
    model: resolved.value.model,
  }
}

interface ToolCallRec {
  id: string
  name: string
  input: unknown
}
interface ToolResultRec {
  id: string
  name: string
  result: ToolResult
}

/** Persist one step: chained assistant message + text/tool/tool_result parts. */
async function persistStep(
  deps: AgentDeps,
  sid: string,
  text: string,
  toolCalls: ToolCallRec[],
  toolResults: ToolResultRec[],
): Promise<void> {
  if (text === '' && toolCalls.length === 0) return

  const tipRes = await Sessions.tip(deps.db, sid)
  const prevId = tipRes.isErr() ? null : tipRes.value
  const insert = await Messages.insert(deps.db, 'assistant', text, prevId)
  if (insert.isErr()) {
    console.error(`[agent] persist step failed (${sid}): ${insert.error}`)
    return
  }
  const messageId = insert.value

  let seq = 0
  if (text !== '') {
    await Parts.insert(deps.db, messageId, 'text', seq++, { text })
  }
  for (const tc of toolCalls) {
    const result = toolResults.find(r => r.id === tc.id)?.result
    await Parts.insert(
      deps.db,
      messageId,
      'tool',
      seq++,
      { id: tc.id, name: tc.name, input: tc.input },
    )
    // Persist the canonical ToolResult (content + opaque metadata) so the
    // history rebuild and the read API can both reproduce it verbatim. The
    // metadata blob belongs to the tool server; the agent never interprets it.
    const content =
      result !== undefined
        ? result.content
        : `tool '${tc.name}' produced no output`
    const metadata = result !== undefined ? result.metadata : null
    await Parts.insert(deps.db, messageId, 'tool_result', seq++, {
      tool_use_id: tc.id,
      content,
      metadata,
    })
  }
  await Sessions.setTip(deps.db, sid, messageId)
}

/** Fold a mailbox event into the chain as an `event` message. */
async function persistEvent(deps: AgentDeps, sid: string, payload: string) {
  const parsed = parse(ContentPayloadSchema, payload)
  const text =
    parsed.isOk() && parsed.value.content !== undefined
      ? parsed.value.content
      : payload
  const tip = await Sessions.tip(deps.db, sid)
  const tipId = tip.isErr() ? null : tip.value
  const insert = await Messages.insert(deps.db, 'event', text, tipId)
  if (insert.isOk()) {
    await Sessions.setTip(deps.db, sid, insert.value)
  }
}

/**
 * Between steps: drain the mailbox and inject everything that arrived.
 *
 * - `user_prompt` → persisted as a `role=user` message (chained) and returned
 *   so the loop continues and the model responds to it.
 * - other event types → folded as `role=event` (as `persistEvent`).
 * - `interrupt` → handled out-of-band by the wake watcher; if one surfaces
 *   here we abort defensively.
 *
 * Returns the list of injected user prompts (may be empty).
 */
async function drainAndInject(
  deps: AgentDeps,
  sid: string,
  ctrl: AbortController,
): Promise<string[]> {
  const injected: string[] = []
  for (;;) {
    const item = await drainOne(deps, sid)
    if (item === null) break
    if (item.msg_type === 'interrupt') {
      ctrl.abort()
      continue
    }
    if (item.msg_type === 'user_prompt') {
      const payload = parse(ContentPayloadSchema, item.payload)
      const text = payload.isOk()
        ? (payload.value.text ?? payload.value.prompt ?? item.payload)
        : item.payload
      await persistUserPrompt(deps, sid, text)
      injected.push(text)
      continue
    }
    await persistEvent(deps, sid, item.payload)
  }
  return injected
}

/** Persist an injected user prompt as a chained `role=user` message. */
async function persistUserPrompt(
  deps: AgentDeps,
  sid: string,
  text: string,
): Promise<void> {
  const tip = await Sessions.tip(deps.db, sid)
  const tipId = tip.isErr() ? null : tip.value
  const insert = await Messages.insert(deps.db, 'user', text, tipId)
  if (insert.isOk()) {
    await Sessions.setTip(deps.db, sid, insert.value)
  }
}

/** Append a completed step to the in-memory message list for the next step. */
function appendStep(
  messages: ModelMessage[],
  text: string,
  toolCalls: ToolCallRec[],
  toolResults: ToolResultRec[],
): ModelMessage[] {
  const content: Array<
    | { type: 'text'; text: string }
    | {
        type: 'tool-call'
        toolCallId: string
        toolName: string
        input: unknown
      }
  > = []
  if (text !== '') content.push({ type: 'text', text })
  for (const tc of toolCalls) {
    content.push({
      type: 'tool-call',
      toolCallId: tc.id,
      toolName: tc.name,
      input: tc.input ?? {},
    })
  }
  const next: ModelMessage[] = [...messages]
  next.push({ role: 'assistant', content })
  if (toolResults.length > 0) {
    next.push({
      role: 'tool',
      content: toolResults.map(r => ({
        type: 'tool-result',
        toolCallId: r.id,
        toolName: r.name,
        output: { type: 'text', value: r.result.content },
      })),
    })
  }
  return next
}

async function loadHistory(
  deps: AgentDeps,
  sid: string,
): Promise<ModelMessage[]> {
  const tipRes = await Sessions.tip(deps.db, sid)
  const tipId = tipRes.isErr() ? null : tipRes.value
  const chain = await Messages.chain(deps.db, tipId, 100_000, null)
  if (chain.isErr()) return []
  const ids = chain.value.map(m => m.id)
  // COW: parts are fetched by message id (not session id) so a fork shares
  // parent parts alongside the shared message chain.
  const parts = await Parts.listByMessages(deps.db, ids)
  if (parts.isErr()) return []
  return rebuildHistory(chain.value, parts.value)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export { events }
