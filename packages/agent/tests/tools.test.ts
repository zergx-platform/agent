import { describe, expect, it } from 'vitest'
import type { Bus } from '../src/bus.js'
import {
  buildAiTools,
  type DiscoveredTool,
  discoverToolsCached,
  invalidateDiscoveryCache,
} from '../src/tools.js'

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
      const payload = resultFor
        ? resultFor(callId)
        : {
            call_id: callId,
            tool: 'read',
            content: 'ok',
            metadata: null,
          }
      yield { payload }
    },
    close: () => {
      /* fake bus has no real subscription to tear down */
    },
  })

  const bus = {
    subscribe: (subject: string) => {
      log.push(`sub:${subject}`)
      const sub = subject.startsWith('abep.tool.result.')
        ? makeSub(subject.slice('abep.tool.result.'.length))
        : makeSub('')
      return Promise.resolve(sub)
    },
    publish: (subject: string, payload: unknown) => {
      log.push(`pub:${subject}`)
      published.push({ subject, payload })
      return Promise.resolve()
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
  extId: 'repo-extension',
  name: 'read',
  description: 'read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
}

const execOpts = (toolCallId: string) => ({ toolCallId, messages: [] }) as never

describe('buildAiTools _session injection', () => {
  it('injects _session into tool call arguments when sessionId given', async () => {
    const { bus, published } = fakeBus()
    const tools = buildAiTools([tool], bus, 500, 'acme--api--main')
    const result = await tools.read.execute({ path: 'x' }, execOpts('c1'))
    expect(result).toEqual({ content: 'ok', metadata: null })
    const call = published.find(
      p => p.subject === 'abep.tool.call.repo-extension.read',
    )
    expect(call?.payload).toEqual({
      call_id: 'c1',
      session_name: 'acme--api--main',
      arguments: { path: 'x', _session: 'acme--api--main' },
    })
  })

  it('passes arguments unchanged when no sessionId', async () => {
    const { bus, published } = fakeBus()
    const tools = buildAiTools([tool], bus, 500)
    await tools.read.execute({ path: 'x' }, execOpts('c2'))
    const call = published.find(
      p => p.subject === 'abep.tool.call.repo-extension.read',
    )
    expect(call?.payload).toEqual({
      call_id: 'c2',
      arguments: { path: 'x' },
    })
  })

  it('subscribes to tool.result.{call_id} before publishing tool.call', async () => {
    const { bus, log } = fakeBus()
    const tools = buildAiTools([tool], bus, 500, 's')
    await tools.read.execute({}, execOpts('c3'))
    expect(log[0]).toBe('sub:abep.tool.result.c3')
    expect(log[1]).toBe('pub:abep.tool.call.repo-extension.read')
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
    expect(replies[0]).toBe('abep.tool.result.c4')
  })
})

describe('discoverToolsCached', () => {
  /** Bus fake counting requestMany broadcasts. */
  const countingBus = (): { bus: Bus; broadcasts: () => number } => {
    let n = 0
    const bus = {
      requestMany: () => {
        n += 1
        return (async () => {
          await new Promise(r => setTimeout(r, 5))
          return [
            {
              v: 1,
              ch: 'abep.discover',
              kind: 'res',
              payload: {
                id: 'repo-extension',
                version: '0.3.0',
                capabilities: ['tools'],
                tools: [{ name: 'read', description: 'd' }],
              },
            },
          ]
        })()
      },
    }
    return { bus: bus as unknown as Bus, broadcasts: () => n }
  }

  it('serves repeat calls from cache within the TTL (one broadcast)', async () => {
    invalidateDiscoveryCache()
    const { bus, broadcasts } = countingBus()
    const a = await discoverToolsCached(bus, 60_000)
    const b = await discoverToolsCached(bus, 60_000)
    expect(a).toHaveLength(1)
    expect(b).toEqual(a)
    expect(broadcasts()).toBe(1)
  })

  it('shares one in-flight broadcast across concurrent callers', async () => {
    invalidateDiscoveryCache()
    const { bus, broadcasts } = countingBus()
    const [a, b] = await Promise.all([
      discoverToolsCached(bus, 60_000),
      discoverToolsCached(bus, 60_000),
    ])
    expect(a).toEqual(b)
    expect(broadcasts()).toBe(1)
  })

  it('re-broadcasts after the TTL expires', async () => {
    invalidateDiscoveryCache()
    const { bus, broadcasts } = countingBus()
    await discoverToolsCached(bus, 10) // 10ms TTL
    await new Promise(r => setTimeout(r, 20))
    await discoverToolsCached(bus, 10)
    expect(broadcasts()).toBe(2)
  })

  it('invalidateDiscoveryCache forces a fresh broadcast', async () => {
    invalidateDiscoveryCache()
    const { bus, broadcasts } = countingBus()
    await discoverToolsCached(bus, 60_000)
    invalidateDiscoveryCache()
    await discoverToolsCached(bus, 60_000)
    expect(broadcasts()).toBe(2)
  })
})
