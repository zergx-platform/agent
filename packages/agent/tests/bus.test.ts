import { describe, expect, it } from 'vitest'
import {
  mailboxSubject,
  natsErrorCode,
  natsToken,
  sseSubject,
} from '../src/bus.js'

const NATS_TOKEN_RE = /^[A-Za-z0-9_-]+$/

describe('natsToken', () => {
  it('maps arbitrary session names to subject-legal tokens', () => {
    for (const sid of [
      'acme:api:main',
      'acme:my.repo:feat-1.2',
      'weird # name with spaces',
      '中文会话',
      'a*b>c',
    ]) {
      const tok = natsToken(sid)
      expect(tok).toMatch(NATS_TOKEN_RE)
      expect(tok.length).toBeLessThanOrEqual(22)
    }
  })

  it('is deterministic and injective on a sample', () => {
    const sids = ['a:b:c', 'a.b.c', 'x', 'a:b', '']
    const seen = new Map<string, string>()
    for (const sid of sids) {
      const tok = natsToken(sid)
      expect(natsToken(sid)).toBe(tok) // stable
      if (seen.has(tok)) {
        throw new Error(`token collision: ${seen.get(tok)} vs ${sid}`)
      }
      seen.set(tok, sid)
    }
  })

  it('subjects never contain the raw session name', () => {
    const sid = 'acme:my.repo:main'
    expect(sseSubject(sid)).toBe(`sse.session.${natsToken(sid)}`)
    expect(mailboxSubject(sid)).toBe(`mailbox.session.${natsToken(sid)}`)
    expect(sseSubject(sid)).not.toContain(':')
  })
})

describe('natsErrorCode', () => {
  it('extracts api_error.err_code from an Error instance', () => {
    // Shape mirrors nats.js NatsError: the envelope is assigned as own
    // properties on the Error subclass instance.
    const e = Object.assign(new Error('wrong last sequence'), {
      api_error: { err_code: 10071, code: 400, description: '...' },
    })
    expect(natsErrorCode(e)).toBe(10071)
  })

  it('returns null on non-matching shapes', () => {
    expect(natsErrorCode(new Error('plain'))).toBeNull()
    expect(natsErrorCode('string error')).toBeNull()
    expect(natsErrorCode(null)).toBeNull()
    expect(natsErrorCode(undefined)).toBeNull()
    expect(natsErrorCode(42)).toBeNull()
    expect(natsErrorCode({ api_error: null })).toBeNull()
    expect(
      natsErrorCode({ api_error: { err_code: 'not-a-number' } }),
    ).toBeNull()
    expect(natsErrorCode({})).toBeNull()
  })
})
