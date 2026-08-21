import type { MessageRow, PartRow } from '@rucoder-agent/schema'
import type { ModelMessage } from 'ai'
import { parse, ToolPartDataSchema, ToolResultPartDataSchema } from './json.js'

/**
 * Rebuild AI SDK ModelMessages from a session's persisted chain.
 *
 * Roles map to the AI SDK contract as follows:
 * - `user`     → user message
 * - `event`    → user message (external event folded into context)
 * - `assistant` → assistant message; its `tool`/`tool_result` parts become an
 *   assistant tool-call message followed by a `role:"tool"` message carrying
 *   every result (paired by `tool_use_id`).
 */
export function rebuildHistory(
  rows: MessageRow[],
  parts: PartRow[],
): ModelMessage[] {
  const out: ModelMessage[] = []
  const byMessage = new Map<string, PartRow[]>()
  for (const p of parts) {
    const list = byMessage.get(p.message_id) ?? []
    list.push(p)
    byMessage.set(p.message_id, list)
  }

  for (const m of rows) {
    if (m.role === 'user' || m.role === 'event') {
      if (m.content !== '') out.push({ role: 'user', content: m.content })
      continue
    }
    if (m.role !== 'assistant') continue

    const msgParts = (byMessage.get(m.id) ?? [])
      .slice()
      .sort((a, b) => a.seq - b.seq)
    const uses: Array<{ id: string; name: string; input: unknown }> = []
    const results: Array<{ toolUseId: string; content: string }> = []
    for (const p of msgParts) {
      if (p.type === 'tool') {
        const d = parse(ToolPartDataSchema, p.data)
        if (d.isOk()) {
          uses.push({
            id: d.value.id,
            name: d.value.name,
            input: d.value.input,
          })
        }
      } else if (p.type === 'tool_result') {
        const d = parse(ToolResultPartDataSchema, p.data)
        if (d.isOk()) {
          results.push({
            toolUseId: d.value.tool_use_id,
            content: d.value.content,
          })
        }
      }
    }

    if (uses.length === 0 && results.length === 0) {
      if (m.content !== '') out.push({ role: 'assistant', content: m.content })
      continue
    }

    const content: Array<
      | { type: 'text'; text: string }
      | {
          type: 'tool-call'
          toolCallId: string
          toolName: string
          input: unknown
        }
    > = []
    if (m.content !== '') content.push({ type: 'text', text: m.content })
    for (const u of uses) {
      content.push({
        type: 'tool-call',
        toolCallId: u.id,
        toolName: u.name,
        input: u.input ?? {},
      })
    }
    out.push({ role: 'assistant', content })
    if (results.length > 0) {
      out.push({
        role: 'tool',
        content: results.map(r => ({
          type: 'tool-result',
          toolCallId: r.toolUseId,
          toolName: uses.find(u => u.id === r.toolUseId)?.name ?? 'tool',
          output: { type: 'text', value: r.content },
        })),
      })
    }
  }
  return out
}
