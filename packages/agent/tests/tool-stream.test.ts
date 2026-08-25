import { describe, expect, it } from 'vitest'
import type { Bus } from '../src/bus.js'
import { invokeToolStreamViaBus } from '../src/tools.js'

function fakeStreamBus(messages: Array<Record<string, unknown>>) {
  let i = 0
  const sub = {
    async *[Symbol.asyncIterator]() {
      while (i < messages.length) {
        yield { payload: messages[i] }
        i++
      }
    },
    close: () => {},
  }
  return {
    subscribe: () => Promise.resolve(sub),
    publish: () => Promise.resolve(),
    objectGet: () => Promise.resolve(new Uint8Array()),
  } as unknown as Bus
}

describe('invokeToolStreamViaBus', () => {
  it('yields one ToolResult per delta, then the final', async () => {
    const bus = fakeStreamBus([
      { call_id: 'c1', tool: 'run', content: 'A\n', stream: 'delta' },
      {
        call_id: 'c1',
        tool: 'run',
        content: 'B\n',
        stream: 'delta',
        metadata: null,
      },
      {
        call_id: 'c1',
        tool: 'run',
        content: 'done',
        stream: 'final',
        metadata: null,
      },
    ])
    const out: string[] = []
    for await (const r of invokeToolStreamViaBus(
      bus,
      'ops',
      'run',
      'c1',
      {},
      5000,
    )) {
      out.push(r.content)
    }
    expect(out).toEqual(['A\n', 'B\n', 'done'])
  })
})
