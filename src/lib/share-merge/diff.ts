import type { Change } from './types'

const MAX_DISTANCE = 20_000

export class DiffLimitError extends Error {
  constructor() {
    super('Myers edit distance exceeds 20000')
    this.name = 'DiffLimitError'
  }
}

// Bidirectional Myers finds a middle snake with only the current two frontiers.
// Forward ties prefer deletion. Reverse diagonals are visited in the mirrored
// order, so simultaneous meetings choose the forward deletion path first.
// The returned point is on a shortest path; splitting there also handles empty snakes.
function bisect(base: Int32Array, side: Int32Array, r: Change): [number, number] {
  const n = r.b1 - r.b0
  const m = r.s1 - r.s0
  const depth = Math.min(Math.ceil((n + m) / 2), MAX_DISTANCE / 2)
  const offset = depth + 1
  const forward = new Int32Array(2 * depth + 3).fill(-1)
  const reverse = new Int32Array(2 * depth + 3).fill(-1)
  forward[offset + 1] = reverse[offset + 1] = 0
  const delta = n - m
  const odd = delta % 2 !== 0
  for (let d = 0; d <= depth; d++) {
    for (let k = d; k >= -d; k -= 2) {
      const at = offset + k
      let x = k === -d || (k !== d && forward[at - 1] < forward[at + 1]) ? forward[at + 1] : forward[at - 1] + 1
      let y = x - k
      if (x < 0 || y < 0 || x > n || y > m) continue
      while (x < n && y < m && base[r.b0 + x] === side[r.s0 + y]) { x++; y++ }
      forward[at] = x
      const backK = delta - k
      if (odd && Math.abs(backK) <= d - 1 && reverse[offset + backK] >= 0 && x + reverse[offset + backK] >= n) return [r.b0 + x, r.s0 + y]
    }
    for (let k = -d; k <= d; k += 2) {
      const at = offset + k
      let x = k === -d || (k !== d && reverse[at - 1] < reverse[at + 1]) ? reverse[at + 1] : reverse[at - 1] + 1
      let y = x - k
      if (x < 0 || y < 0 || x > n || y > m) continue
      while (x < n && y < m && base[r.b1 - x - 1] === side[r.s1 - y - 1]) { x++; y++ }
      reverse[at] = x
      const frontK = delta - k
      if (!odd && Math.abs(frontK) <= d && forward[offset + frontK] >= 0 && x + forward[offset + frontK] >= n) {
        const splitX = forward[offset + frontK]
        return [r.b0 + splitX, r.s0 + splitX - frontK]
      }
    }
  }
  // Search is capped before allocating or retaining any quadratic edit trace.
  throw new DiffLimitError()
}

export function diff(base: string[], side: string[]): Change[] {
  let b0 = 0
  let b1 = base.length
  let s1 = side.length
  while (b0 < b1 && b0 < s1 && base[b0] === side[b0]) b0++
  const s0 = b0
  while (b1 > b0 && s1 > s0 && base[b1 - 1] === side[s1 - 1]) { b1--; s1-- }
  if (b0 === b1 && s0 === s1) return []

  const ids = new Map<string, number>()
  const encode = (tokens: string[]) => Int32Array.from(tokens, token => {
    let id = ids.get(token)
    if (id === undefined) { id = ids.size; ids.set(token, id) }
    return id
  })
  const a = encode(base)
  const b = encode(side)
  // Multiset intersection bounds LCS from above: reject provably excessive D cheaply.
  const counts = new Int32Array(ids.size)
  for (let i = b0; i < b1; i++) counts[a[i]]++
  let common = 0
  for (let i = s0; i < s1; i++) if (counts[b[i]] > 0) { counts[b[i]]--; common++ }
  const size = b1 - b0 + s1 - s0
  if (size - 2 * common > MAX_DISTANCE) throw new DiffLimitError()
  if (common === 0) return [{ b0, b1, s0, s1 }]

  const changes: Change[] = []
  const pending: Change[] = [{ b0, b1, s0, s1 }]
  while (pending.length) {
    const r = pending.pop()!
    while (r.b0 < r.b1 && r.s0 < r.s1 && a[r.b0] === b[r.s0]) { r.b0++; r.s0++ }
    while (r.b1 > r.b0 && r.s1 > r.s0 && a[r.b1 - 1] === b[r.s1 - 1]) { r.b1--; r.s1-- }
    if (r.b0 === r.b1 && r.s0 === r.s1) continue
    if (r.b0 === r.b1 || r.s0 === r.s1) {
      const last = changes[changes.length - 1]
      if (last && last.b1 === r.b0 && last.s1 === r.s0) { last.b1 = r.b1; last.s1 = r.s1 }
      else changes.push(r)
      continue
    }
    // bisect's arrays are released before descending; the explicit stack avoids recursion.
    const [x, y] = bisect(a, b, r)
    pending.push({ b0: x, b1: r.b1, s0: y, s1: r.s1 }, { b0: r.b0, b1: x, s0: r.s0, s1: y })
  }
  return changes
}
