import { describe, expect, it } from 'vitest'
import {
  COMPACTION_ROLE,
  checkpointContent,
  type FoldEntry,
  foldQA,
  splitScan,
} from '../src/compaction.js'

function entry(
  id: string,
  role: string,
  text: string,
  toolCalls = 0,
): FoldEntry {
  return { id, role, text, toolCalls }
}

describe('foldQA', () => {
  it('folds user → assistant Q&A, dropping event messages', () => {
    const out = foldQA([
      entry('e1', 'event', 'system event text'),
      entry('u1', 'user', '请修 bug'),
      entry('a1', 'assistant', '', 3),
      entry('a2', 'assistant', '修复完成'),
      entry('u2', 'user', '再加个测试'),
      entry('a3', 'assistant', '好的'),
    ])
    expect(out).toBe(
      [
        'User: 请修 bug',
        'Assistant: [After 3 tool calls] 修复完成',
        'User: 再加个测试',
        'Assistant: [After 0 tool calls] 好的',
      ].join('\n\n'),
    )
  })

  it('concatenates multiple non-thinking text parts in one turn', () => {
    const out = foldQA([
      entry('u1', 'user', 'q'),
      entry('a1', 'assistant', '第一步', 1),
      entry('a2', 'assistant', '第二步', 2),
    ])
    expect(out).toContain('Assistant: [After 3 tool calls] 第一步\n第二步')
  })
})

describe('splitScan', () => {
  it('skips compaction messages entirely', () => {
    const entries = [
      entry('f1', 'user', '折叠的用户指令'),
      entry('f2', 'assistant', '折叠的回复', 2),
      entry('cm1', COMPACTION_ROLE, '', 0),
      entry('u1', 'user', '保留的用户指令'),
      entry('a1', 'assistant', '保留的回复'),
    ]
    const r = splitScan(entries, 4, 200)
    // Compaction message must not appear in tail or folded.
    expect(r.tail.map(e => e.id)).not.toContain('cm1')
    expect(r.folded.map(e => e.id)).not.toContain('cm1')
    expect(r.tail.map(e => e.id)).toContain('u1')
    expect(r.folded.map(e => e.id)).toContain('f1')
  })

  it('keeps everything in tail when within tail budget', () => {
    const entries = [entry('u1', 'user', 'hi'), entry('a1', 'assistant', 'ok')]
    const r = splitScan(entries, 10_000, 10_000)
    expect(r.tail.map(e => e.id)).toEqual(['u1', 'a1'])
    expect(r.folded).toEqual([])
  })

  it('aligns tail boundary to a user message', () => {
    const pad = 'x'.repeat(40)
    const entries = [
      entry('u1', 'user', `第一轮${pad}`),
      entry('a1', 'assistant', `回复一${pad}`, 2),
      entry('u2', 'user', `第二轮${pad}`),
      entry('a2', 'assistant', `回复二${pad}`, 1),
      entry('u3', 'user', `第三轮${pad}`),
      entry('a3', 'assistant', '回复三'),
    ]
    const r = splitScan(entries, 60, 60)
    expect(r.tail.length).toBeGreaterThan(0)
    expect(r.tail[0]!.role).toBe('user')
  })
})

describe('checkpointContent', () => {
  it('wraps summary in checkpoint tags', () => {
    const out = checkpointContent('hi')
    expect(out).toContain('<conversation-checkpoint>')
    expect(out).toContain('hi')
  })
})
