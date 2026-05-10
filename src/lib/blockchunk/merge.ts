import type { BlockFingerprint } from './fingerprint'
import { jaccard, coverage } from './fingerprint'

export interface OldBlockEntry { id: string; fp: BlockFingerprint }
export interface NewBlockEntry  { fp: BlockFingerprint }

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
 * 5-pass merge.
 *
 * Output partitioning rule: each new block index appears in EXACTLY ONE of
 * `kept | edited | splits[].newIdx | splits[].siblings | merges | fresh`.
 * Each old block index appears in EXACTLY ONE of `kept | edited |
 * splits | merges | retired`.
 *
 *   1. exact hash equality (kept)
 *   2. Jaccard ≥ threshold, 1:1 greedy (edited; new inherits oldId)
 *   3. one old → multiple new with ≥ splitCoverage (split; first sibling by
 *      coverage inherits oldId, the rest are recorded under siblings[] —
 *      they are NOT in fresh; the caller assigns them fresh ids with
 *      parents=[oldId])
 *   4. multiple old → one new with ≥ splitCoverage (merge; new is in
 *      merges[]. The OLD blocks are NOT pushed to retired by this function;
 *      the caller iterates merges[].oldIds and creates the retirement
 *      entries with the new block's allocated id as replacedBy)
 *   5. residue: unmatched old → retired (replacedBy=[]); unmatched new → fresh
 *
 * Lineage assignment is the caller's responsibility:
 *   - kept/edited:  inherit oldId; parents=[]; created_gen unchanged
 *   - splits.newIdx: inherit splits.oldId; parents=[]; created_gen unchanged
 *   - splits.siblings: fresh id; parents=[splits.oldId]; new created_gen
 *   - merges: fresh id; parents=merges.oldIds; new created_gen
 *   - fresh: fresh id; parents=[]; new created_gen
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
      // Siblings belong solely to splits[].siblings — exclude them from
      // Pass 5's fresh residue so each new index appears in exactly one
      // outcome category.
      for (const s of siblings) newUsed.add(s.ni)
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
      for (const m of matchedOld) oldUsed.add(m.oi)
      // Note: the caller derives retired entries for merge participants from
      // out.merges (each merges.oldIds[i] retires with replacedBy=[<allocated
      // new id>]). We don't push retired entries here because we don't yet
      // know the new id.
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
