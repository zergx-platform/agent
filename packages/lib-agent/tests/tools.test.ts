import { describe, expect, it } from 'vitest'
import { injectSessionCtx } from '../src/tools.js'

describe('injectSessionCtx', () => {
  const ctx = { org: 'acme', repo: 'demo', branch: 'main' }

  it('injects _org/_repo/_branch', () => {
    const out = injectSessionCtx({ x: 1 }, ctx)
    expect(out).toEqual({ x: 1, _org: 'acme', _repo: 'demo', _branch: 'main' })
  })

  it('preserves LLM-supplied values', () => {
    const out = injectSessionCtx({ _org: 'override' }, ctx)
    expect(out._org).toBe('override')
    expect(out._repo).toBe('demo')
  })
})
