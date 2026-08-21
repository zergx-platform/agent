import type { ProviderRow } from '@rucoder-agent/schema'
import { describe, expect, it } from 'vitest'
import { findProviderForModel } from '../src/db-providers.js'

const row = (id: string, models: string): ProviderRow => ({
  provider_id: id,
  api_type: 'openai-compatible',
  base_url: 'http://x/v1',
  api_key: '',
  headers: 'null',
  models,
  updated_at: '',
})

describe('findProviderForModel', () => {
  it('matches exact model id', () => {
    const rows = [row('a', '["deepseek-v4-pro"]'), row('b', '["gpt-5","o4"]')]
    expect(findProviderForModel(rows, 'gpt-5')?.provider_id).toBe('b')
    expect(findProviderForModel(rows, 'deepseek-v4-pro')?.provider_id).toBe('a')
  })

  it('returns null for unknown or empty models', () => {
    const rows = [row('a', '["gpt-5"]')]
    expect(findProviderForModel(rows, 'gpt-4')).toBeNull()
    expect(findProviderForModel(rows, '')).toBeNull()
  })

  it('ignores malformed models json', () => {
    expect(findProviderForModel([row('a', 'not json')], 'gpt-5')).toBeNull()
  })
})
