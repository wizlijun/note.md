import { expect, it } from 'vitest'
import { diff, DiffLimitError } from './diff'

function verify(base: string[], side: string[]) {
  const changes = diff(base, side)
  let b = 0
  let s = 0
  let distance = 0
  for (const c of changes) {
    expect(base.slice(b, c.b0)).toEqual(side.slice(s, c.s0))
    expect(c.b0).toBeGreaterThanOrEqual(b)
    expect(c.s0).toBeGreaterThanOrEqual(s)
    distance += c.b1 - c.b0 + c.s1 - c.s0
    b = c.b1
    s = c.s1
  }
  expect(base.slice(b)).toEqual(side.slice(s))
  // Small independent edit-distance oracle; production never allocates this matrix.
  let row = Array.from({ length: side.length + 1 }, (_, i) => i)
  for (let i = 1; i <= base.length; i++) {
    const next = [i]
    for (let j = 1; j <= side.length; j++) next[j] = base[i - 1] === side[j - 1] ? row[j - 1] : Math.min(row[j], next[j - 1]) + 1
    row = next
  }
  expect(distance).toBe(row[side.length])
  expect(diff(base, side)).toEqual(changes)
}

it('finds shortest deterministic edits for exhaustive repeated-token inputs', () => {
  const samples: string[][] = [[]]
  for (let n = 1; n <= 5; n++) for (let mask = 0; mask < 2 ** n; mask++) samples.push(Array.from({ length: n }, (_, i) => String((mask >> i) & 1)))
  for (const a of samples) for (const b of samples) verify(a, b)
})

it('strips common ends and uses deletion before insertion for a repeated-token tie', () => {
  expect(diff(['pre', 'a', 'b', 'post'], ['pre', 'b', 'a', 'post'])).toEqual([
    { b0: 1, b1: 2, s0: 1, s1: 1 },
    { b0: 3, b1: 3, s0: 2, s1: 3 },
  ])
})

it('coalesces consecutive deletion and insertion into one replacement', () => {
  expect(diff(['a', 'b'], ['c', 'd'])).toEqual([{ b0: 0, b1: 2, s0: 0, s1: 2 }])
  expect(diff([], [])).toEqual([])
})

it('enforces the global distance limit at empty and disjoint exact boundaries', () => {
  expect(diff([], Array(20_000).fill('a'))).toHaveLength(1)
  expect(() => diff([], Array(20_001).fill('a'))).toThrow(DiffLimitError)
  expect(diff(Array(10_000).fill('a'), Array(10_000).fill('b'))).toHaveLength(1)
  expect(() => diff(Array(10_001).fill('a'), Array(10_000).fill('b'))).toThrow(DiffLimitError)
})

it('enforces total D across multiple changes rather than a per-region budget', () => {
  const base = [...Array(5_001).fill('a'), 'shared', ...Array(5_000).fill('a')]
  const side = [...Array(5_000).fill('b'), 'shared', ...Array(5_000).fill('b')]
  expect(() => diff(base, side)).toThrow(DiffLimitError)
})

it('checks the real shortest D when the multiset lower bound is zero', () => {
  const left = Array(10_000).fill('a')
  const right = Array(10_000).fill('b')
  const changes = diff([...left, ...right], [...right, ...left])
  expect(changes.reduce((d, c) => d + c.b1 - c.b0 + c.s1 - c.s0, 0)).toBe(20_000)
  expect(() => diff([...left, ...right], [...right, 'b', ...left])).toThrow(DiffLimitError)
  expect(() => diff([...left, 'a', ...right, 'b'], [...right, 'b', ...left, 'a'])).toThrow(DiffLimitError)
}, 20_000)

it('matches the shortest-distance oracle on 500 longer seeded inputs', () => {
  let seed = 0x12345678
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 12) % n }
  for (let i = 0; i < 500; i++) {
    const sample = () => Array.from({ length: next(40) }, () => String(next(5)))
    verify(sample(), sample())
  }
})
