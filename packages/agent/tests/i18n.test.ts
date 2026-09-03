import { describe, expect, it } from 'vitest'
import { localizeSchema, pickLocalized } from '../src/i18n.js'

describe('pickLocalized', () => {
  it('exact match wins, region falls back to primary', () => {
    const map = { zh: '中文', 'zh-hant': '繁體' }
    expect(pickLocalized(map, 'zh')).toBe('中文')
    expect(pickLocalized(map, 'zh-hans')).toBe('中文')
    expect(pickLocalized(map, 'zh-hant')).toBe('繁體')
    expect(pickLocalized(map, 'en')).toBeNull()
  })
})

describe('localizeSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Target bookmark',
        descriptions: { zh: '目标书签' },
      },
      plain: { type: 'string', description: 'No translations here' },
      nested: {
        type: 'object',
        properties: {
          deep: {
            type: 'string',
            description: 'Deep prop',
            descriptions: { zh: '深层属性' },
          },
        },
      },
      list: {
        type: 'array',
        items: {
          type: 'string',
          description: 'Item',
          descriptions: { zh: '条目' },
        },
      },
    },
    required: ['target'],
  }

  it('resolves property descriptions for the locale and strips the map', () => {
    const out = localizeSchema(schema, 'zh')
    expect(out.properties.target.description).toBe('目标书签')
    expect(out.properties.target.descriptions).toBeUndefined()
    expect(out.properties.nested.properties.deep.description).toBe('深层属性')
    expect(out.properties.list.items.description).toBe('条目')
    // Untouched nodes keep their description.
    expect(out.properties.plain.description).toBe('No translations here')
    // Structural keys survive.
    expect(out.required).toEqual(['target'])
    expect(out.type).toBe('object')
  })

  it('missing locale entries fall back to the default description', () => {
    const out = localizeSchema(schema, 'ja')
    expect(out.properties.target.description).toBe('Target bookmark')
    expect(out.properties.target.descriptions).toBeUndefined()
  })

  it('region variants fall back to the primary language', () => {
    const out = localizeSchema(schema, 'zh-hans')
    expect(out.properties.target.description).toBe('目标书签')
  })

  it('does not mutate the input schema', () => {
    localizeSchema(schema, 'zh')
    expect(schema.properties.target.descriptions).toEqual({ zh: '目标书签' })
    expect(schema.properties.target.description).toBe('Target bookmark')
  })
})
