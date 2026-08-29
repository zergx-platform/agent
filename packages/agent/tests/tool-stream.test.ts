import { describe, expect, it } from 'vitest'
import type { Bus } from '../src/bus.js'
import { buildAiTools } from '../src/tools.js'

function fakeResultBus(messages: Array<Record<string, unknown>>) {
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
    request: (ch: string) =>
      Promise.resolve({ payload: messages[Math.max(0, i - 1)] }),
  } as unknown as Bus
}

describe('buildAiTools', () => {
  it('returns a single terminal ToolResult (no streamed deltas)', async () => {
    const bus = fakeResultBus([
      { call_id: 'c1', tool: 'run', content: 'done', metadata: null },
    ])
    const tools = buildAiTools(
      [
        {
          extId: 'ops',
          name: 'run',
          description: 'run a command',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      bus,
      5000,
    )
    const out = await tools.run?.execute?.(
      {},
      {
        toolCallId: 'c1',
        messages: [],
        abortSignal: new AbortController().signal,
      },
    )
    expect(out?.content).toBe('done')
  })
})
