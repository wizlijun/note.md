import type { Change } from './types'

export interface Region {
  b0: number
  b1: number
  ours: Change[]
  theirs: Change[]
}

export function overlaps(a: Change, b: Change): boolean {
  if (a.b0 === a.b1 && b.b0 === b.b1) return a.b0 === b.b0
  if (a.b0 === a.b1) return b.b0 <= a.b0 && a.b0 <= b.b1
  if (b.b0 === b.b1) return a.b0 <= b.b0 && b.b0 <= a.b1
  return Math.max(a.b0, b.b0) < Math.min(a.b1, b.b1)
}

// Each side's diff is ordered and disjoint. Sweep cross-side intersections, then
// take their transitive closure; touching nonempty intervals never create an edge.
export function mergeRegions(ours: Change[], theirs: Change[]): Region[] {
  const all = [...ours, ...theirs]
  const parents = all.map((_, i) => i)
  const find = (i: number): number => {
    while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i] }
    return i
  }
  let first = 0
  for (let i = 0; i < ours.length; i++) {
    const a = ours[i]
    while (first < theirs.length && theirs[first].b1 < a.b0) first++
    for (let j = first; j < theirs.length && theirs[j].b0 <= a.b1; j++) {
      if (overlaps(a, theirs[j])) parents[find(j + ours.length)] = find(i)
    }
  }
  const groups = new Map<number, Region>()
  for (let i = 0; i < all.length; i++) {
    const c = all[i]
    const root = find(i)
    let region = groups.get(root)
    if (!region) { region = { b0: c.b0, b1: c.b1, ours: [], theirs: [] }; groups.set(root, region) }
    region.b0 = Math.min(region.b0, c.b0)
    region.b1 = Math.max(region.b1, c.b1)
    if (i < ours.length) region.ours.push(c)
    else region.theirs.push(c)
  }
  return [...groups.values()].sort((a, b) => a.b0 - b.b0 || a.b1 - b.b1)
}
