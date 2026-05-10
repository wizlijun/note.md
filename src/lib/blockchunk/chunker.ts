import type { BreakPoint } from './breakpoints'
import { isInsideCodeFence, type CodeFenceRegion } from './codefences'

/**
 * Chunking constants. Differences from qmd:
 *  - Smaller target (600 vs 900 tokens) for finer AI attribution
 *  - Zero overlap (qmd uses 15% for retrieval recall; we want 1:1 block-to-id)
 */
export const CHUNK_SIZE_TOKENS = 600
export const CHUNK_OVERLAP_TOKENS = 0
export const CHUNK_SIZE_CHARS = CHUNK_SIZE_TOKENS * 4 // ~4 chars/token
export const CHUNK_OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * 4
export const CHUNK_WINDOW_TOKENS = 200
export const CHUNK_WINDOW_CHARS = CHUNK_WINDOW_TOKENS * 4

/**
 * Pick the best position to cut at, walking back up to `windowChars` from
 * `targetCharPos`. Each candidate's score is multiplied by a squared-distance
 * decay (gentle near target, steep at the window edge):
 *
 *   normalizedDist = (target - pos) / windowChars
 *   multiplier     = 1 - normalizedDist² × decayFactor
 *
 * Result: a far-away h1 (score 100) easily beats a nearby blank line (20),
 * but a low-quality break right at the target edge will only beat candidates
 * far back.
 *
 * Break points inside code fences are skipped so we never split a code block.
 */
export function findBestCutoff(
  breakPoints: BreakPoint[],
  targetCharPos: number,
  windowChars: number = CHUNK_WINDOW_CHARS,
  decayFactor: number = 0.7,
  codeFences: CodeFenceRegion[] = [],
): number {
  const windowStart = targetCharPos - windowChars
  let bestScore = -1
  let bestPos = targetCharPos
  for (const bp of breakPoints) {
    if (bp.pos < windowStart) continue
    if (bp.pos > targetCharPos) break // sorted; safe to stop
    if (isInsideCodeFence(bp.pos, codeFences)) continue
    const distance = targetCharPos - bp.pos
    const normalizedDist = distance / windowChars
    const multiplier = 1.0 - normalizedDist * normalizedDist * decayFactor
    const finalScore = bp.score * multiplier
    if (finalScore > bestScore) {
      bestScore = finalScore
      bestPos = bp.pos
    }
  }
  return bestPos
}
