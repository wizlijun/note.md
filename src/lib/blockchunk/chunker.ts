import type { BreakPoint } from './breakpoints'
import { scanBreakPoints } from './breakpoints'
import { isInsideCodeFence, findCodeFences, type CodeFenceRegion } from './codefences'

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

/**
 * One result of chunking. `src_pos` is the character offset in the source;
 * `src_line` is the 1-based line containing that offset.
 */
export interface Block {
  text: string
  src_pos: number
  src_line: number
}

/**
 * Pure helper that takes pre-scanned break points and code-fence regions and
 * walks the content greedily, choosing the best cut at each step.
 */
export function chunkDocumentWithBreakPoints(
  content: string,
  breakPoints: BreakPoint[],
  codeFences: CodeFenceRegion[],
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
): { text: string; pos: number }[] {
  if (content.length <= maxChars) {
    return [{ text: content, pos: 0 }]
  }
  const chunks: { text: string; pos: number }[] = []
  let charPos = 0
  while (charPos < content.length) {
    const targetEndPos = Math.min(charPos + maxChars, content.length)
    let endPos = targetEndPos
    if (endPos < content.length) {
      const bestCutoff = findBestCutoff(
        breakPoints,
        targetEndPos,
        windowChars,
        0.7,
        codeFences,
      )
      if (bestCutoff > charPos && bestCutoff <= targetEndPos) endPos = bestCutoff
      // If endPos still lands inside a code fence (bestCutoff fallback when no
      // good break was found in window), advance to the fence's end. Without
      // this, a chunk boundary could cut a code block in half — visually
      // catastrophic for the generated .block.md.
      for (const fence of codeFences) {
        if (endPos > fence.start && endPos < fence.end) {
          endPos = fence.end
          break
        }
      }
    }
    if (endPos <= charPos) endPos = Math.min(charPos + maxChars, content.length)
    chunks.push({ text: content.slice(charPos, endPos), pos: charPos })
    if (endPos >= content.length) break
    charPos = endPos - overlapChars
    const last = chunks.at(-1)!
    if (charPos <= last.pos) charPos = endPos
  }
  return chunks
}

/**
 * Top-level entry: scan + chunk + attach `src_line`. Returns `Block[]`.
 */
export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
): Block[] {
  const breakPoints = scanBreakPoints(content)
  const codeFences = findCodeFences(content)
  const raw = chunkDocumentWithBreakPoints(
    content, breakPoints, codeFences,
    maxChars, overlapChars, windowChars,
  )
  return raw.map((c) => ({
    text: c.text,
    src_pos: c.pos,
    src_line: lineOf(content, c.pos),
  }))
}

function lineOf(content: string, pos: number): number {
  // 1-based line number containing `pos`. Counts newlines strictly before it.
  let line = 1
  for (let i = 0; i < pos; i++) if (content.charCodeAt(i) === 10) line++
  return line
}

/**
 * Merge two break-point arrays, keeping the highest score at each position.
 * Sorted by position. Currently unused by chunker; reserved for future
 * AST/extension break sources (parity with qmd's API).
 */
export function mergeBreakPoints(a: BreakPoint[], b: BreakPoint[]): BreakPoint[] {
  const seen = new Map<number, BreakPoint>()
  for (const bp of a) {
    const e = seen.get(bp.pos)
    if (!e || bp.score > e.score) seen.set(bp.pos, bp)
  }
  for (const bp of b) {
    const e = seen.get(bp.pos)
    if (!e || bp.score > e.score) seen.set(bp.pos, bp)
  }
  return Array.from(seen.values()).sort((a, b) => a.pos - b.pos)
}
