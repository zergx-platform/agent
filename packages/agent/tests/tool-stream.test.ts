import { ResultAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import type { Bus } from '../src/bus.js'
import { invokeToolStreamViaBus } from '../src/tools.js'

function fakeStreamBus(messages: Array<Record<string, unknown>>) {
  let i = 0
  const sub = {
    async *[Symbol.asyncIterator]() {
      while (i < messages.length) {
        yield { data: Buffer.from(JSON.stringify(messages[i])) }
        i++
      }
    },
    unsubscribe: () => {},
  }
  return {
    subscribe: () => ResultAsync.fromSafePromise(Promise.resolve(sub)),
    publish: () => ResultAsync.fromSafePromise(Promise.resolve(undefined)),
    getObject: (name: string) =>
      ResultAsync.fromSafePromise(Promise.resolve(Buffer.from(''))),
  } as unknown as Bus
}

describe('invokeToolStreamViaBus', () => {
  it('yields one ToolResult per delta, then the final', async () => {
    const bus = fakeStreamBus([
      { call_id: 'c1', tool: 'run', content: 'A\n', stream: 'delta' },
      { call_id: 'c1', tool: 'run', content: 'B\n', stream: 'delta' },
      { call_id: 'c1', tool: 'run', content: 'done', stream: 'final', metadata: null },
    ])
    const out: string[] = []
    for await (const r of invokeToolStreamViaBus(bus, 'ops', 'run', 'c1', {}, 5000)) {
      out.push(r.content)
    }
    expect(out).toEqual(['A\n', 'B\n', 'done'])
  })
})
