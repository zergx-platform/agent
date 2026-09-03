import { describe, expect, it } from 'vitest'
import type { Bus } from '../src/bus.js'
import { SYSTEM_PRESETS } from '../src/default-presets.js'
import { Presets } from '../src/kv-store.js'

const BUCKET = 'abc-presets'

interface KV {
  [key: string]: string
}

function fakeBus(initial: KV = {}) {
  const kv: KV = { ...initial }
  const bus = {
    kvGet: async (b: string, key: string) =>
      b === BUCKET ? (kv[key] ?? null) : null,
    kvPut: async (b: string, key: string, value: string) => {
      if (b === BUCKET) kv[key] = value
    },
    kvCreate: async (b: string, key: string, value: string) => {
      if (b !== BUCKET) return null
      if (kv[key] !== undefined) return null
      kv[key] = value
      return 1
    },
    kvDelete: async (b: string, key: string) => {
      if (b === BUCKET) delete kv[key]
    },
  } as unknown as Bus
  return { bus, kv }
}

describe('system preset set', () => {
  it('defines the three roles', () => {
    const ids = SYSTEM_PRESETS.map(p => p.id)
    expect(ids).toEqual(['orchestrator', 'executor', 'analyst'])
  })

  it('every system preset is bilingual and lists known tools', () => {
    for (const p of SYSTEM_PRESETS) {
      expect(p.tools).toBeTruthy()
      expect(JSON.parse(p.tools).length).toBeGreaterThan(0)
      const i18n = JSON.parse(p.systemPromptI18n)
      expect(i18n.zh).toMatch(/.+/)
      expect(i18n.en).toBe(p.systemPrompt)
    }
  })
})

describe('Presets.seedDefaults', () => {
  it('seeds every system preset into an empty bucket', async () => {
    const { bus, kv } = fakeBus()
    const r = await Presets.seedDefaults(bus)
    expect(r.isOk()).toBe(true)
    for (const p of SYSTEM_PRESETS) {
      expect(kv[p.id]).toBeDefined()
    }
    expect(JSON.parse(kv.__ids__)).toEqual(
      expect.arrayContaining(SYSTEM_PRESETS.map(p => p.id)),
    )
  })

  it('is idempotent across repeated calls (never overwrites)', async () => {
    const { bus, kv } = fakeBus()
    await Presets.seedDefaults(bus)
    // Simulate a restore/another writer changing one system preset's raw value.
    const edited = SYSTEM_PRESETS[0]
    await bus.kvPut(
      BUCKET,
      edited.id,
      JSON.stringify({ ...JSON.parse(kv[edited.id]), systemPrompt: 'EDITED' }),
    )
    const before = await bus.kvGet(BUCKET, edited.id)
    await Presets.seedDefaults(bus)
    const after = await bus.kvGet(BUCKET, edited.id)
    expect(after).toBe(before)
  })

  it('skips ids whose create returned null (already present)', async () => {
    const { bus, kv } = fakeBus()
    const one = SYSTEM_PRESETS[0]
    await bus.kvPut(BUCKET, one.id, JSON.stringify(one))
    await Presets.seedDefaults(bus)
    expect(await bus.kvGet(BUCKET, one.id)).toBe(JSON.stringify(one))
  })
})

describe('system presets are immutable', () => {
  it('rejects upsert with a system id', async () => {
    const { bus } = fakeBus()
    const r = await Presets.upsert(bus, {
      id: SYSTEM_PRESETS[0].id,
      systemPrompt: 'x',
      systemPromptI18n: '{}',
      tools: '[]',
      maxTurns: 3,
    })
    expect(r.isErr()).toBe(true)
    expect(String(r.error)).toContain('immutable')
  })

  it('rejects delete with a system id', async () => {
    const { bus } = fakeBus()
    const r = await Presets.delete(bus, SYSTEM_PRESETS[0].id)
    expect(r.isErr()).toBe(true)
    expect(String(r.error)).toContain('immutable')
  })

  it('allows user presets upsert/delete', async () => {
    const { bus, kv } = fakeBus()
    await Presets.upsert(bus, {
      id: 'my',
      systemPrompt: 's',
      systemPromptI18n: '{}',
      tools: '[]',
      maxTurns: 5,
    })
    expect(kv.my).toBeDefined()
    await Presets.delete(bus, 'my')
    expect(kv.my).toBeUndefined()
  })

  it('exposes is_system on list', async () => {
    const { bus, kv } = fakeBus()
    await Presets.seedDefaults(bus)
    const list = await Presets.list(bus)
    expect(list.isOk()).toBe(true)
    const sys = list.value.find(p => p.id === 'orchestrator')
    expect(sys?.is_system).toBe(true)
    await Presets.upsert(bus, {
      id: 'user1',
      systemPrompt: 's',
      systemPromptI18n: '{}',
      tools: '[]',
      maxTurns: 2,
    })
    const list2 = await Presets.list(bus)
    expect(list2.value.find(p => p.id === 'user1')?.is_system).toBe(false)
  })
})
