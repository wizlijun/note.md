import { describe, it, expect } from 'vitest'
import { NavHistory } from './nav-history'

type View = { kind: 'feed'; date?: string } | { kind: 'page'; page: string }

describe('daily/nav-history', () => {
  it('push then back/forward', () => {
    const h = new NavHistory<View>({ kind: 'feed' })
    expect(h.current()).toEqual({ kind: 'feed' })
    h.push({ kind: 'page', page: 'A' })
    h.push({ kind: 'page', page: 'B' })
    expect(h.current()).toEqual({ kind: 'page', page: 'B' })
    expect(h.canBack()).toBe(true)
    expect(h.back()).toEqual({ kind: 'page', page: 'A' })
    expect(h.forward()).toEqual({ kind: 'page', page: 'B' })
  })
  it('push after back truncates forward tail', () => {
    const h = new NavHistory<View>({ kind: 'feed' })
    h.push({ kind: 'page', page: 'A' })
    h.back()
    h.push({ kind: 'page', page: 'C' })
    expect(h.canForward()).toBe(false)
    expect(h.current()).toEqual({ kind: 'page', page: 'C' })
  })
  it('back/forward at ends are no-ops returning current', () => {
    const h = new NavHistory<View>({ kind: 'feed' })
    expect(h.canBack()).toBe(false)
    expect(h.back()).toEqual({ kind: 'feed' })
    expect(h.forward()).toEqual({ kind: 'feed' })
  })
})
