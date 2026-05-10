import type { ActiveBlock } from '../blockio/yaml-schema'

export interface LineBlockEntry {
  blockid: string
  isStart: boolean   // true if this line is the block's src_line
}

/**
 * Build a 1-based `Map<line, LineBlockEntry>` covering [1, totalLines].
 * Each line falls into exactly one block, namely the block with the largest
 * src_line ≤ line.
 */
export function buildLineBlockMap(
  active: ActiveBlock[],
  totalLines: number,
): Map<number, LineBlockEntry> {
  const map = new Map<number, LineBlockEntry>()
  if (active.length === 0) return map
  const sorted = [...active].sort((a, b) => a.src_line - b.src_line)
  let bi = 0
  for (let line = 1; line <= totalLines; line++) {
    while (bi + 1 < sorted.length && sorted[bi + 1].src_line <= line) bi++
    if (line < sorted[bi].src_line) continue // before first block; rare
    map.set(line, {
      blockid: sorted[bi].id,
      isStart: sorted[bi].src_line === line,
    })
  }
  return map
}
