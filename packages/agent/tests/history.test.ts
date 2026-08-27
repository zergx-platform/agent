import type { MessageRow, PartRow } from '@zergx-agent/schema'
import { describe, expect, it } from 'vitest'
import { rebuildHistory } from '../src/history.js'

function msg(id: string, role: string): MessageRow {
  return {
    id,
    role,
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
    type,
    seq,
    data: JSON.stringify(data),
  }
}

const text = (messageId: string, seq: number, t: string): PartRow =>
  part(messageId, seq, 'text', { text: t })

describe('rebuildHistory', () => {
  it('maps plain text turns from text parts', () => {
    const out = rebuildHistory(
      [msg('m1', 'user'), msg('m2', 'assistant')],
      [text('m1', 0, 'hi'), text('m2', 0, 'hello')],
    )
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('folds event messages into user turns', () => {
    const out = rebuildHistory([msg('m1', 'event')], [text('m1', 0, 'ctx')])
    expect(out).toEqual([{ role: 'user', content: 'ctx' }])
  })

  it('concatenates multiple text parts in seq order', () => {
    const out = rebuildHistory(
      [msg('m1', 'assistant')],
      [text('m1', 0, 'first '), text('m1', 1, 'second')],
    )
    expect(out).toEqual([{ role: 'assistant', content: 'first second' }])
  })

  it('expands tool use + result into assistant/tool message pair', () => {
    const out = rebuildHistory(
      [msg('m1', 'user'), msg('m2', 'assistant')],
      [
        text('m1', 0, 'list files'),
        part('m2', 0, 'tool', {
          id: 't1',
          name: 'ls',
          input: { path: '/' },
        }),
        part('m2', 1, 'tool_result', {
          tool_use_id: 't1',
          content: 'a.txt',
          metadata: null,
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
      [msg('m1', 'assistant')],
      [part('m1', 0, 'tool', { no_id: true })],
    )
    expect(out).toEqual([])
  })

  it('keeps empty-content assistant with tools', () => {
    const out = rebuildHistory(
      [msg('m1', 'assistant')],
      [part('m1', 0, 'tool', { id: 't9', name: 'x', input: {} })],
    )
    expect(out).toHaveLength(1)
    const a = out[0] as { content: Array<{ type: string }> }
    expect(a.content[0]?.type).toBe('tool-call')
  })

  it('merges text with tool calls in one assistant message', () => {
    const out = rebuildHistory(
      [msg('m1', 'assistant')],
      [
        text('m1', 0, 'running'),
        part('m1', 1, 'tool', { id: 't1', name: 'x', input: {} }),
        part('m1', 2, 'tool_result', {
          tool_use_id: 't1',
          content: 'done',
          metadata: null,
        }),
      ],
    )
    expect(out).toHaveLength(2)
    const a = out[0] as { content: Array<{ type: string; text?: string }> }
    expect(a.content[0]?.type).toBe('text')
    expect(a.content[1]?.type).toBe('tool-call')
  })
})
