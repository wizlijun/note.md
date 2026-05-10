/**
 * Citation regex. Strict requirements:
 *   - pageuri may be empty or any chars except `(`, `)`, `#`
 *   - blockid is `b-` + exactly 6 lowercase hex chars
 *
 * Use with /g flag for repeated matching; the exported version has no flags
 * so callers can pick the appropriate flag set.
 */
export const CITATION_RE = /\(\(([^()#]*)#(b-[0-9a-f]{6})\)\)/

export interface ParsedCitation {
  raw: string
  pageuri: string     // may be ''
  blockid: string
  start: number       // offset in source
  end: number         // exclusive
}

export function parseCitations(text: string): ParsedCitation[] {
  const re = new RegExp(CITATION_RE.source, 'g')
  const out: ParsedCitation[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({
      raw: m[0],
      pageuri: m[1],
      blockid: m[2],
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return out
}

/**
 * Find the citation that contains `cursor` (selectionStart) in `text`,
 * if any. Used by source-mode "follow citation under cursor".
 */
export function citationAtCursor(text: string, cursor: number): ParsedCitation | null {
  for (const c of parseCitations(text)) {
    if (cursor >= c.start && cursor <= c.end) return c
  }
  return null
}
