import type { PartRow } from '@zergx-agent/schema'
import { describe, expect, it } from 'vitest'
import { checkpointContent } from '../src/compaction.js'
import type { ChainMessage } from '../src/db-messages.js'
import { spliceContext } from '../src/session-agent.js'

function msg(id: string, role: string): ChainMessage {
  return {
    id,
    role,
    prev_id: null,
    tool_name: '',
    tool_call_id: '',
    created_at: '',
    content: '',
    tool_parts: [],
    file_parts: [],
  }
}

function textPart(messageId: string, text: string): PartRow {
  return {
    id: `${messageId}-t`,
    message_id: messageId,
    type: 'text',
    seq: 0,
    data: JSON.stringify({ text }),
  }
}

function summaryPart(
  messageId: string,
  summary: string,
  tailFrom: string | null,
): PartRow {
  return {
    id: `${messageId}-s`,
    message_id: messageId,
    type: 'summary',
    seq: 0,
    data: JSON.stringify({ summary, tail_from: tailFrom }),
  }
}

describe('spliceContext', () => {
  it('rebuilds verbatim when there is no compaction message', () => {
    const rows = [msg('m1', 'user'), msg('m2', 'assistant')]
    const parts = [textPart('m1', 'hello'), textPart('m2', 'hi there')]
    const out = spliceContext(rows, parts)
    expect(out).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ])
  })

  it('keeps the verbatim tail recorded by tail_from', () => {
    // oldest-first: m1(user) m2(assistant) cm(compaction) m4(user) m5(assistant)
    const rows = [
      msg('m1', 'user'),
      msg('m2', 'assistant'),
      msg('cm', 'compaction'),
      msg('m4', 'user'),
      msg('m5', 'assistant'),
    ]
    const parts = [
      textPart('m1', 'old question'),
      textPart('m2', 'old answer'),
      summaryPart('cm', 'earlier conversation', 'm4'),
      textPart('m4', 'new question'),
      textPart('m5', 'new answer'),
    ]
    const out = spliceContext(rows, parts)
    expect(out[0]).toEqual({
      role: 'user',
      content: checkpointContent('earlier conversation'),
    })
    expect(out.slice(1)).toEqual([
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: 'new answer' },
    ])
  })

  it('finds the NEWEST compaction message, not the oldest', () => {
    // two compaction messages; only the newest tail applies
    const rows = [
      msg('m1', 'user'),
      msg('cm1', 'compaction'),
      msg('m3', 'user'),
      msg('cm2', 'compaction'),
      msg('m5', 'user'),
    ]
    const parts = [
      summaryPart('cm1', 'very old', 'm3'),
      summaryPart('cm2', 'recent', 'm5'),
      textPart('m5', 'latest question'),
    ]
    const out = spliceContext(rows, parts)
    expect(out[0]).toEqual({
      role: 'user',
      content: checkpointContent('recent'),
    })
    expect(out.slice(1)).toEqual([{ role: 'user', content: 'latest question' }])
  })

  it('falls back to messages after the cm when tail_from is absent (legacy)', () => {
    const rows = [msg('m1', 'user'), msg('cm', 'compaction'), msg('m3', 'user')]
    const parts = [
      textPart('m1', 'old'),
      summaryPart('cm', 'legacy summary', null),
      textPart('m3', 'after'),
    ]
    const out = spliceContext(rows, parts)
    expect(out[0]).toEqual({
      role: 'user',
      content: checkpointContent('legacy summary'),
    })
    expect(out.slice(1)).toEqual([{ role: 'user', content: 'after' }])
  })
})
