import { describe, it, expect } from 'vitest'
import { newBlockId, BLOCK_ID_RE } from './id'

describe('BLOCK_ID_RE', () => {
  it('matches "b-" + 6 lowercase hex', () => {
    expect(BLOCK_ID_RE.test('b-7f3a9c')).toBe(true)
    expect(BLOCK_ID_RE.test('b-ABCDEF')).toBe(false) // uppercase rejected
    expect(BLOCK_ID_RE.test('b-12345')).toBe(false)  // too short
    expect(BLOCK_ID_RE.test('b-1234567')).toBe(false) // too long
    expect(BLOCK_ID_RE.test('a-123456')).toBe(false) // wrong prefix
  })
})

describe('newBlockId', () => {
  it('returns a BLOCK_ID_RE-matching id', () => {
    const id = newBlockId(new Set())
    expect(BLOCK_ID_RE.test(id)).toBe(true)
  })

  it('does not collide with reserved set', () => {
    const reserved = new Set<string>()
    for (let i = 0; i < 100; i++) reserved.add(newBlockId(reserved).slice(0)) // accumulate
    // After 100 generations, the set is dense for that subspace; ensure each
    // newly returned id was not already in the set when allocated.
    expect(reserved.size).toBe(100)
  })

  it('throws after 3 retries when the space is exhausted (synthetic)', () => {
    // Pre-fill a Set that "covers" any possible new id by mocking. Easiest:
    // pass a Proxy-Set whose .has() always returns true.
    const everFull = {
      has: (_: string) => true,
      add: (_: string) => everFull,
    } as unknown as Set<string>
    expect(() => newBlockId(everFull)).toThrow(/exhausted/i)
  })
})
