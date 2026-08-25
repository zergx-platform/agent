import type { KV } from 'nats'
import { describe, expect, it, vi } from 'vitest'
import { Bus } from '../src/bus.js'

function fakeKV(
  updateImpl: (k: string, data: unknown, rev: number) => Promise<number>,
): KV {
  return {
    update: updateImpl,
    create: vi.fn(async () => 1),
    delete: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
  } as unknown as KV
}

describe('Bus.renewSession', () => {
  it('returns the NEW revision on a successful CAS update', async () => {
    const kv = fakeKV(async () => 7)
    const bus = new Bus({} as never, {} as never, kv, kv)
    const res = await bus.renewSession('a:b:main', 3)
    expect(res.isOk()).toBe(true)
    expect(res._unsafeUnwrap()).toBe(7)
  })

  it('returns null when the revision is stale (wrong last sequence)', async () => {
    const stale = Object.assign(new Error('wrong last sequence'), {
      api_error: { err_code: 10071 },
    })
    const kv = fakeKV(async () => {
      throw stale
    })
    const bus = new Bus({} as never, {} as never, kv, kv)
    const res = await bus.renewSession('a:b:main', 3)
    expect(res.isOk()).toBe(true)
    expect(res._unsafeUnwrap()).toBeNull()
  })

  it('propagates non-contention errors', async () => {
    const kv = fakeKV(async () => {
      throw new Error('nats down')
    })
    const bus = new Bus({} as never, {} as never, kv, kv)
    const res = await bus.renewSession('a:b:main', 3)
    expect(res.isErr()).toBe(true)
  })
})

describe('Bus.claimSession', () => {
  it('returns the KV revision on claim', async () => {
    const kv = fakeKV(async () => 1)
    kv.create = vi.fn(async () => 5) as never
    const bus = new Bus({} as never, {} as never, kv, kv)
    const res = await bus.claimSession('a:b:main')
    expect(res.isOk()).toBe(true)
    expect(res._unsafeUnwrap()).toBe(5)
  })

  it('returns null on contention (key already exists)', async () => {
    const stale = Object.assign(new Error('wrong last sequence'), {
      api_error: { err_code: 10071 },
    })
    const kv = fakeKV(async () => 1)
    kv.create = vi.fn(async () => {
      throw stale
    }) as never
    const bus = new Bus({} as never, {} as never, kv, kv)
    const res = await bus.claimSession('a:b:main')
    expect(res.isOk()).toBe(true)
    expect(res._unsafeUnwrap()).toBeNull()
  })

  it('propagates non-contention claim errors', async () => {
    const kv = fakeKV(async () => 1)
    kv.create = vi.fn(async () => {
      throw new Error('nats down')
    }) as never
    const bus = new Bus({} as never, {} as never, kv, kv)
    const res = await bus.claimSession('a:b:main')
    expect(res.isErr()).toBe(true)
  })
})
