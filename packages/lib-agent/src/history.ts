import type { MessageRow, PartRow } from '@rucoder-agent/schema'
import type { ModelMessage } from 'ai'

interface ToolUsePart {
  kind: 'tool'
  id: string
  name: string
  input: unknown
}

interface ToolResultPart {
  kind: 'tool_result'
  toolUseId: string
  content: string
}

/**
 * Rebuild AI SDK ModelMessages from a session's persisted chain: user/system
 * messages become user turns; an assistant message expands into an assistant
 * message with tool-call content plus (when results exist) a following tool
 * message — the AI SDK contract for feeding results back.
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
    if (m.role === 'user' || m.role === 'system') {
      if (m.content !== '') out.push({ role: 'user', content: m.content })
      continue
    }
    if (m.role !== 'assistant') continue

    const msgParts = (byMessage.get(m.id) ?? [])
      .slice()
      .sort((a, b) => a.seq - b.seq)
    const uses: ToolUsePart[] = []
    const results: ToolResultPart[] = []
    for (const p of msgParts) {
      if (p.type === 'tool') {
        const d = JSON.parse(p.data) as {
          id?: string
          name?: string
          input?: unknown
        }
        if (d.id !== undefined && d.name !== undefined) {
          uses.push({ kind: 'tool', id: d.id, name: d.name, input: d.input })
        }
      } else if (p.type === 'tool_result') {
        const d = JSON.parse(p.data) as {
          tool_use_id?: string
          content?: string
        }
        if (d.tool_use_id !== undefined) {
          results.push({
            kind: 'tool_result',
            toolUseId: d.tool_use_id,
            content: d.content ?? '',
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
