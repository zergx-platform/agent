import { err, ok } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'
import { Mailbox } from '../src/db-mailbox.js'
import type { AgentDeps } from '../src/session-agent.js'
import { handleMailboxMessage } from '../src/session-agent.js'

/** Minimal JsMsg fake with ack/nak/term recorded. */
function fakeMsg(data: unknown) {
  const calls: string[] = []
  return {
    data: Buffer.from(JSON.stringify(data)),
    ack: () => calls.push('ack'),
    nak: (ms?: number) => calls.push(`nak:${ms ?? ''}`),
    term: () => calls.push('term'),
    calls,
  }
}

describe('handleMailboxMessage', () => {
  it('persists a valid envelope and acks', async () => {
    const enqueue = vi
      .spyOn(Mailbox, 'enqueueIdempotent')
      .mockReturnValue(ok('e1') as never)
    const claim = vi.fn().mockReturnValue(ok(null))
    const deps = {
      db: {},
      bus: { claimSession: claim },
      config: {},
      llm: {},
    } as unknown as AgentDeps

    const msg = fakeMsg({
      id: 'e1',
      session_name: 'a:b:main',
      type: 'event',
      payload: { text: 'hi' },
    })
    await handleMailboxMessage(deps, msg as never)

    expect(enqueue).toHaveBeenCalledWith(deps.db, 'e1', 'a:b:main', 'event', {
      text: 'hi',
    })
    expect(msg.calls).toContain('ack')
    enqueue.mockRestore()
  })

  it('triggers the session turn after ack', async () => {
    vi.spyOn(Mailbox, 'enqueueIdempotent').mockReturnValue(ok('e1') as never)
    const claim = vi.fn().mockReturnValue(ok(null))
    const deps = {
      db: {},
      bus: { claimSession: claim },
      config: {},
      llm: {},
    } as unknown as AgentDeps

    const msg = fakeMsg({
      id: 'e1',
      session_name: 'a:b:main',
      type: 'event',
      payload: { text: 'hi' },
    })
    await handleMailboxMessage(deps, msg as never)

    // runSessionTurn is fire-and-forget; the mock claim returns contention
    // (null) so the turn exits immediately after being invoked.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(claim).toHaveBeenCalledWith('a:b:main')
  })

  it('terms a malformed envelope', async () => {
    const msg = fakeMsg({ no_id: true })
    await handleMailboxMessage({} as AgentDeps, msg as never)
    expect(msg.calls).toContain('term')
    expect(msg.calls).not.toContain('ack')
  })

  it('terms on foreign-key violation', async () => {
    vi.spyOn(Mailbox, 'enqueueIdempotent').mockReturnValue(
      err('insert ... violates foreign key constraint (23503)') as never,
    )
    const msg = fakeMsg({
      id: 'e2',
      session_name: 'gone',
      type: 'event',
      payload: {},
    })
    await handleMailboxMessage({} as AgentDeps, msg as never)
    expect(msg.calls).toContain('term')
    expect(msg.calls).not.toContain('ack')
    expect(msg.calls.find(c => c.startsWith('nak'))).toBeUndefined()
  })

  it('naks on transient enqueue failure', async () => {
    vi.spyOn(Mailbox, 'enqueueIdempotent').mockReturnValue(
      err('connection refused') as never,
    )
    const msg = fakeMsg({
      id: 'e3',
      session_name: 'a:b:main',
      type: 'event',
      payload: {},
    })
    await handleMailboxMessage({} as AgentDeps, msg as never)
    expect(msg.calls.find(c => c.startsWith('nak'))).toBe('nak:5000')
    expect(msg.calls).not.toContain('ack')
  })
})
