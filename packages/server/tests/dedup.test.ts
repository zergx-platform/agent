import { describe, expect, it } from 'vitest'
import { EidDedup } from '../src/context.js'

describe('EidDedup', () => {
  it('dedupes replay vs live by eid', () => {
    const d = new EidDedup()
    d.mark('a')
    expect(d.duplicate('a')).toBe(true)
    expect(d.duplicate('b')).toBe(false)
    expect(d.duplicate('b')).toBe(true)
  })

  it('never treats missing eid as duplicate', () => {
    const d = new EidDedup()
    expect(d.duplicate(undefined)).toBe(false)
    expect(d.duplicate(undefined)).toBe(false)
  })

  it('evicts oldest beyond cap', () => {
    const d = new EidDedup(2)
    d.mark('a')
    d.mark('b')
    d.mark('c') // evicts 'a'
    expect(d.duplicate('a')).toBe(false)
    expect(d.duplicate('b')).toBe(true)
  })
})
