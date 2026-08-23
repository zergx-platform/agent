import { ResultAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import type { Bus } from '../src/bus.js'
import { buildAiTools, type DiscoveredTool } from '../src/tools.js'

interface Published {
  subject: string
  payload: unknown
}

/** A Bus fake compatible with the neverthrow chain in invokeToolViaBus. */
function fakeBus() {
  const published: Published[] = []
  const log: string[] = []
  let resultFor: ((callId: string) => unknown) | null = null

  const makeSub = (callId: string) => ({
    async *[Symbol.asyncIterator]() {
      const data = resultFor
        ? JSON.stringify(resultFor(callId))
        : JSON.stringify({
            call_id: callId,
            tool: 'read',
            content: 'ok',
            metadata: null,
          })
      yield { data: Buffer.from(data) }
    },
  })

  const bus = {
    subscribe: (subject: string) => {
      log.push(`sub:${subject}`)
      const sub =
        subject.startsWith('tool.result.')
          ? makeSub(subject.slice('tool.result.'.length))
          : makeSub('')
      return ResultAsync.fromSafePromise(Promise.resolve(sub))
    },
    publish: (subject: string, payload: unknown) => {
      log.push(`pub:${subject}`)
      published.push({ subject, payload })
      return ResultAsync.fromSafePromise(Promise.resolve(undefined))
    },
  }
  return {
    bus: bus as unknown as Bus,
    published,
    log,
    replyWith: (fn: (callId: string) => unknown) => {
      resultFor = fn
    },
  }
}

const tool: DiscoveredTool = {
  name: 'read',
  description: 'read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
}

const execOpts = (toolCallId: string) =>
  ({ toolCallId, messages: [] }) as never

describe('buildAiTools _session injection', () => {
  it('injects _session into tool call arguments when sessionId given', async () => {
    const { bus, published } = fakeBus()
    const tools = buildAiTools([tool], bus, 500, 'acme--api--main')
    const result = await tools.read.execute(
      { path: 'x' },
      execOpts('c1'),
    )
    expect(result).toEqual({ content: 'ok', metadata: null })
    const call = published.find(p => p.subject === 'tool.call.read')
    expect(call?.payload).toEqual({
      call_id: 'c1',
      arguments: { path: 'x', _session: 'acme--api--main' },
    })
  })

  it('passes arguments unchanged when no sessionId', async () => {
    const { bus, published } = fakeBus()
    const tools = buildAiTools([tool], bus, 500)
    await tools.read.execute({ path: 'x' }, execOpts('c2'))
    const call = published.find(p => p.subject === 'tool.call.read')
    expect(call?.payload).toEqual({
      call_id: 'c2',
      arguments: { path: 'x' },
    })
  })

  it('subscribes to tool.result.{call_id} before publishing tool.call', async () => {
    const { bus, log } = fakeBus()
    const tools = buildAiTools([tool], bus, 500, 's')
    await tools.read.execute({}, execOpts('c3'))
    expect(log[0]).toBe('sub:tool.result.c3')
    expect(log[1]).toBe('pub:tool.call.read')
  })

  it('publishes with reply=tool.result.{call_id} (extension SDKs need it)', async () => {
    const { bus } = fakeBus()
    const busAny = bus as unknown as {
      publish: (
        subject: string,
        payload: unknown,
        reply?: string,
      ) => { andThen: (fn: (v: unknown) => unknown) => unknown }
    }
    const replies: Array<string | undefined> = []
    const tools = buildAiTools(
      [tool],
      {
        ...busAny,
        publish: (subject: string, payload: unknown, reply?: string) => {
          replies.push(reply)
          return busAny.publish(subject, payload, reply)
        },
      } as unknown as typeof bus,
      500,
      's',
    )
    await tools.read.execute({}, execOpts('c4'))
    expect(replies[0]).toBe('tool.result.c4')
  })
})
