/**
 * A potential split position in a markdown document, with a score that
 * reflects how clean/structural the position is. Ported from qmd's
 * src/store.ts BreakPoint interface.
 */
export interface BreakPoint {
  pos: number
  score: number
  type: string
}

/**
 * Patterns ordered by score (highest first). When multiple patterns match
 * the same position, the higher score wins; this is how `\n#` is recorded
 * as 'h1' (100) instead of 'newline' (1).
 */
export const BREAK_PATTERNS: [RegExp, number, string][] = [
  [/\n#{1}(?!#)/g, 100, 'h1'],
  [/\n#{2}(?!#)/g, 90, 'h2'],
  [/\n#{3}(?!#)/g, 80, 'h3'],
  [/\n#{4}(?!#)/g, 70, 'h4'],
  [/\n#{5}(?!#)/g, 60, 'h5'],
  [/\n#{6}(?!#)/g, 50, 'h6'],
  [/\n```/g, 80, 'codeblock'],
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60, 'hr'],
  [/\n\n+/g, 20, 'blank'],
  [/\n[-*]\s/g, 5, 'list'],
  [/\n\d+\.\s/g, 5, 'numlist'],
  [/\n/g, 1, 'newline'],
]

/**
 * Scan `text` for all candidate break points. When more than one pattern
 * matches the same position, the higher-scoring one wins. Result is sorted
 * by position ascending.
 */
export function scanBreakPoints(text: string): BreakPoint[] {
  const seen = new Map<number, BreakPoint>()
  for (const [pattern, score, type] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index!
      const existing = seen.get(pos)
      if (!existing || score > existing.score) {
        seen.set(pos, { pos, score, type })
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.pos - b.pos)
}
