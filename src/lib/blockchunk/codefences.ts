/**
 * A region delimited by ``` fences in markdown. Splitting MUST NOT happen
 * inside such a region (would break code rendering and visual integrity).
 */
export interface CodeFenceRegion {
  start: number
  end: number
}

/**
 * Pair up `\n```` markers into open/close regions. An unclosed fence is
 * treated as extending to the end of the document.
 */
export function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = []
  const fencePattern = /\n```/g
  let inFence = false
  let fenceStart = 0
  for (const match of text.matchAll(fencePattern)) {
    if (!inFence) {
      fenceStart = match.index!
      inFence = true
    } else {
      regions.push({ start: fenceStart, end: match.index! + match[0].length })
      inFence = false
    }
  }
  if (inFence) regions.push({ start: fenceStart, end: text.length })
  return regions
}

/**
 * Strict-interior containment check. Boundary positions are NOT inside.
 */
export function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some((f) => pos > f.start && pos < f.end)
}
