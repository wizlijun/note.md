import type { BlockFingerprint } from './fingerprint'
import { jaccard } from './fingerprint'

export interface OldBlockEntry { id: string; fp: BlockFingerprint; text: string }
export interface NewBlockEntry  { fp: BlockFingerprint; text: string }

export interface MergeOutcome {
  kept:    { newIdx: number; oldId: string }[]
  edited:  { newIdx: number; oldId: string; similarity: number }[]
  splits:  { newIdx: number; oldId: string; siblings: number[] }[]
  merges:  { newIdx: number; oldIds: string[] }[]
  fresh:   { newIdx: number }[]
  retired: { oldId: string; replacedBy: string[] }[]
}

const TINY_BLOCK_LEN = 20

/**
 * 5-pass merge:
 *   1. exact hash equality → kept
 *   2. Jaccard ≥ threshold (1:1) → edited (id inherited)
 *   3. one old maps to 2+ new with ≥ splitCoverage → split (one sibling
 *      inherits id; the rest get fresh ids with parents=[oldId])
 *   4. multiple old map to one new with ≥ splitCoverage → merge (all old
 *      retire; new gets fresh id with parents=[...])
 *   5. residue: unmatched old → retired (deleted); unmatched new → fresh
 *
 * Lineage on the new block (carried by the caller, not by this function):
 *   - kept/edited: parents=[]
 *   - splits.siblings (the non-inheriting new entries): parents=[oldId]
 *   - merges: parents=oldIds
 *   - fresh: parents=[]
 */
export function mergeBlocks(
  oldBlocks: OldBlockEntry[],
  newBlocks: NewBlockEntry[],
  threshold = 0.5,
  splitCoverage = 0.3,
): MergeOutcome {
  const out: MergeOutcome = {
    kept: [], edited: [], splits: [], merges: [], fresh: [], retired: [],
  }

  const oldUsed = new Set<number>()
  const newUsed = new Set<number>()

  // ---- Pass 1: exact hash, document order tiebreak ----
  // For each old in order, find the first un-used new with same hash.
  for (let oi = 0; oi < oldBlocks.length; oi++) {
    if (oldUsed.has(oi)) continue
    const oh = oldBlocks[oi].fp.hash
    for (let ni = 0; ni < newBlocks.length; ni++) {
      if (newUsed.has(ni)) continue
      if (newBlocks[ni].fp.hash === oh) {
        out.kept.push({ newIdx: ni, oldId: oldBlocks[oi].id })
        oldUsed.add(oi); newUsed.add(ni)
        break
      }
    }
  }

  // ---- Pass 2: Jaccard ≥ threshold, greedy by descending similarity ----
  // Compute pairwise sim only on remaining; skip tiny blocks (Jaccard noisy).
  const candidates: { oi: number; ni: number; sim: number }[] = []
  for (let oi = 0; oi < oldBlocks.length; oi++) {
    if (oldUsed.has(oi)) continue
    if (oldBlocks[oi].fp.length < TINY_BLOCK_LEN) continue
    for (let ni = 0; ni < newBlocks.length; ni++) {
      if (newUsed.has(ni)) continue
      if (newBlocks[ni].fp.length < TINY_BLOCK_LEN) continue
      const s = jaccard(oldBlocks[oi].fp, newBlocks[ni].fp)
      if (s >= threshold) candidates.push({ oi, ni, sim: s })
    }
  }
  candidates.sort((a, b) => b.sim - a.sim)
  for (const c of candidates) {
    if (oldUsed.has(c.oi) || newUsed.has(c.ni)) continue
    out.edited.push({ newIdx: c.ni, oldId: oldBlocks[c.oi].id, similarity: c.sim })
    oldUsed.add(c.oi); newUsed.add(c.ni)
  }

  // Coverage helper: shingles of `small` ⊆ shingles of `big` (rough).
  function coverage(small: BlockFingerprint, big: BlockFingerprint): number {
    if (small.shingles === '' || big.shingles === '') return 0
    const A = new Set(small.shingles.split('|'))
    const B = new Set(big.shingles.split('|'))
    let inter = 0
    for (const s of A) if (B.has(s)) inter++
    return A.size === 0 ? 0 : inter / A.size
  }

  // ---- Pass 3: split (one old → multiple new) ----
  for (let oi = 0; oi < oldBlocks.length; oi++) {
    if (oldUsed.has(oi)) continue
    const matchedNew: { ni: number; cov: number }[] = []
    for (let ni = 0; ni < newBlocks.length; ni++) {
      if (newUsed.has(ni)) continue
      const cov = coverage(newBlocks[ni].fp, oldBlocks[oi].fp)
      if (cov >= splitCoverage) matchedNew.push({ ni, cov })
    }
    if (matchedNew.length >= 2) {
      matchedNew.sort((a, b) => b.cov - a.cov)
      const inheritor = matchedNew[0]
      const siblings = matchedNew.slice(1)
      out.splits.push({
        newIdx: inheritor.ni,
        oldId: oldBlocks[oi].id,
        siblings: siblings.map((s) => s.ni),
      })
      oldUsed.add(oi)
      newUsed.add(inheritor.ni)
    }
  }

  // ---- Pass 4: merge (multiple old → one new) ----
  for (let ni = 0; ni < newBlocks.length; ni++) {
    if (newUsed.has(ni)) continue
    const matchedOld: { oi: number; cov: number }[] = []
    for (let oi = 0; oi < oldBlocks.length; oi++) {
      if (oldUsed.has(oi)) continue
      const cov = coverage(oldBlocks[oi].fp, newBlocks[ni].fp)
      if (cov >= splitCoverage) matchedOld.push({ oi, cov })
    }
    if (matchedOld.length >= 2) {
      out.merges.push({ newIdx: ni, oldIds: matchedOld.map((m) => oldBlocks[m.oi].id) })
      newUsed.add(ni)
      for (const m of matchedOld) {
        oldUsed.add(m.oi)
        out.retired.push({ oldId: oldBlocks[m.oi].id, replacedBy: [`${ni}`] })
      }
    }
  }

  // ---- Pass 5: residue ----
  for (let oi = 0; oi < oldBlocks.length; oi++) {
    if (!oldUsed.has(oi)) {
      out.retired.push({ oldId: oldBlocks[oi].id, replacedBy: [] })
    }
  }
  for (let ni = 0; ni < newBlocks.length; ni++) {
    if (!newUsed.has(ni)) {
      out.fresh.push({ newIdx: ni })
    }
  }

  return out
}
