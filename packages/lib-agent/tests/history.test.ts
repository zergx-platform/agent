import type { MessageRow, PartRow } from '@rucoder-agent/schema'
import { describe, expect, it } from 'vitest'
import { rebuildHistory } from '../src/history.js'

function msg(id: string, role: string, content: string): MessageRow {
  return {
    id,
    session_id: 's',
    role,
    content,
    parts_json: '[]',
    prev_id: null,
    tool_name: '',
    tool_call_id: '',
    created_at: '2026-01-01 00:00:00',
  }
}

function part(
  messageId: string,
  seq: number,
  type: string,
  data: unknown,
): PartRow {
  return {
    id: `p-${messageId}-${seq}`,
    message_id: messageId,
    session_id: 's',
    type,
    change_id: null,
    seq,
    data: JSON.stringify(data),
  }
}

describe('rebuildHistory', () => {
  it('maps plain text turns', () => {
    const out = rebuildHistory(
      [msg('m1', 'user', 'hi'), msg('m2', 'assistant', 'hello')],
      [],
    )
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('folds system messages into user turns', () => {
    const out = rebuildHistory([msg('m1', 'system', 'ctx')], [])
    expect(out).toEqual([{ role: 'user', content: 'ctx' }])
  })

  it('expands tool use + result into assistant/tool message pair', () => {
    const out = rebuildHistory(
      [msg('m1', 'user', 'list files'), msg('m2', 'assistant', '')],
      [
        part('m2', 0, 'tool', {
          id: 't1',
          name: 'ls',
          input: { path: '/' },
        }),
        part('m2', 1, 'tool_result', {
          tool_use_id: 't1',
          content: 'a.txt',
        }),
      ],
    )
    expect(out).toHaveLength(3)
    const assistant = out[1] as {
      role: string
      content: Array<{ type: string }>
    }
    expect(assistant.role).toBe('assistant')
    expect(assistant.content[0]?.type).toBe('tool-call')
    const tool = out[2] as {
      role: string
      content: Array<{ type: string; output: { value: string } }>
    }
    expect(tool.role).toBe('tool')
    expect(tool.content[0]?.type).toBe('tool-result')
    expect(tool.content[0]?.output.value).toBe('a.txt')
  })

  it('skips malformed parts', () => {
    const out = rebuildHistory(
      [msg('m1', 'assistant', 'done')],
      [part('m1', 0, 'tool', { no_id: true })],
    )
    expect(out).toEqual([{ role: 'assistant', content: 'done' }])
  })

  it('keeps empty-content assistant with tools', () => {
    const out = rebuildHistory(
      [msg('m1', 'assistant', '')],
      [part('m1', 0, 'tool', { id: 't9', name: 'x', input: {} })],
    )
    expect(out).toHaveLength(1)
    const a = out[0] as { content: Array<{ type: string }> }
    expect(a.content[0]?.type).toBe('tool-call')
  })
})
