import { ok, okAsync } from 'neverthrow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bus } from '../src/bus.js'
import { Mailbox } from '../src/db-mailbox.js'
import type { AgentDeps } from '../src/session-agent.js'
import { runSessionTurn } from '../src/session-agent.js'

type DrainItem = { msg_type: string; payload: string }

function fakeBus(overrides: {
  claim: (sid: string) => ReturnType<Bus['claimSession']>
  release?: (sid: string) => ReturnType<Bus['releaseSession']>
}) {
  return {
    claimSession: overrides.claim,
    renewSession: () => ok(1),
    releaseSession:
      overrides.release ??
      (() => {
        void 0
        return ok(undefined)
      }),
    isSessionRunning: () => ok(false),
    getSessionIds: () => ok(null),
    putSessionIds: () => ok(undefined),
    appendSessionId: () => ok(undefined),
    deleteSessionIds: () => ok(undefined),
    publishStream: () => okAsync(undefined),
    subscribe: () => ok({}),
    publish: () => ok(undefined),
  } as unknown as Bus
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runSessionTurn', () => {
  it('returns without draining when another replica holds the lease', async () => {
    const drain = vi
      .spyOn(Mailbox, 'drainOne')
      .mockResolvedValue(ok(null) as never)
    const bus = fakeBus({ claim: () => ok(null) })
    await runSessionTurn(
      { db: {}, bus, config: {}, llm: {} } as AgentDeps,
      'a:b:main',
    )
    expect(drain).not.toHaveBeenCalled()
  })

  it('drains the mailbox and releases the lease when drained empty', async () => {
    let released = false
    vi.spyOn(Mailbox, 'drainOne').mockResolvedValue(ok(null) as never)
    const bus = fakeBus({
      claim: () => ok(5),
      release: () => {
        released = true
        return ok(undefined)
      },
    })
    await runSessionTurn(
      { db: {}, bus, config: {}, llm: {} } as AgentDeps,
      'a:b:main',
    )
    expect(released).toBe(true)
  })

  it('releases the lease even when draining throws', async () => {
    let released = false
    vi.spyOn(Mailbox, 'drainOne').mockRejectedValue(new Error('db down'))
    const bus = fakeBus({
      claim: () => ok(5),
      release: () => {
        released = true
        return ok(undefined)
      },
    })
    await expect(
      runSessionTurn(
        { db: {}, bus, config: {}, llm: {} } as AgentDeps,
        'a:b:main',
      ),
    ).rejects.toThrow('db down')
    expect(released).toBe(true)
  })
})
