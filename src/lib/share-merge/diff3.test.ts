import { expect, it } from 'vitest'
import { mergeRegions, overlaps } from './diff3'
import type { Change } from './types'

const change = (b0: number, b1: number): Change => ({ b0, b1, s0: b0, s1: b1 })

it('uses exactly the three overlap rules, symmetrically', () => {
  for (const [a, b, expected] of [
    [change(0, 1), change(1, 2), false],
    [change(0, 2), change(1, 3), true],
    [change(1, 1), change(1, 1), true],
    [change(1, 1), change(2, 2), false],
    [change(0, 0), change(0, 2), true],
    [change(2, 2), change(0, 2), true],
    [change(3, 3), change(0, 2), false],
  ] as const) {
    expect(overlaps(a, b)).toBe(expected)
    expect(overlaps(b, a)).toBe(expected)
  }
})

it('takes transitive closure through insertion endpoints', () => {
  const ours = [change(0, 1), change(2, 3)]
  const theirs = [change(1, 2)]
  expect(mergeRegions(ours, theirs)).toHaveLength(3)
  const bridged = mergeRegions([change(0, 1), change(1, 2)], [change(1, 1)])
  expect(bridged).toEqual([{ b0: 0, b1: 2, ours: [change(0, 1), change(1, 2)], theirs: [change(1, 1)] }])
})

it('takes transitive closure across alternating overlapping changes', () => {
  const regions = mergeRegions([change(0, 3), change(5, 8)], [change(2, 6), change(9, 10)])
  expect(regions.map(r => [r.b0, r.b1])).toEqual([[0, 8], [9, 10]])
  expect(regions[0].ours).toHaveLength(2)
  expect(regions[0].theirs).toHaveLength(1)
})
