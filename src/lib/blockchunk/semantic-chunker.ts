import type { Block } from './chunker'
import { chunkDocument } from './chunker'

/**
 * Section-first markdown chunker with size guardrails.
 *
 * Strategy:
 *   1. Identify all headings (h1..h6), respecting code fences.
 *   2. Cut into initial sections at every heading whose level ≤ cutLevel.
 *      A leading region before the first cut is kept as a "preamble" section.
 *   3. Recursive split: any section whose size > maxChars and which contains
 *      sub-headings at the next deeper level is split there. Repeat one level
 *      at a time until no oversized section can be further split via headings.
 *   4. Size-based fallback: any section still over maxChars is run through the
 *      size-bounded chunker (chunkDocument) for that section's text.
 *   5. Merge undersized sections forward into the previous section, so each
 *      block ends up between minChars and maxChars (with the size fallback
 *      caveat for pathological content).
 *   6. If the document has zero headings, fall back to chunkDocument entirely.
 *
 * Block boundary convention matches the size chunker:
 *   - Block N's text spans lines [src_line, src_end_line] inclusive
 *   - Text does NOT include the trailing \n of its last line
 *   - Block N+1 starts on the next line
 */
export interface SemanticChunkOptions {
  cutLevel?: number      // default 2 (H2)
  maxChars?: number      // default 2400
  minChars?: number      // default 400
  windowChars?: number   // for the size-fallback path; default 800
}

interface RawSection { startLine: number; endLine: number; depth: number }

function findLineStarts(content: string): number[] {
  const out: number[] = [0]
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) out.push(i + 1)
  }
  return out
}

interface Heading { line: number; level: number }

function findHeadings(content: string): Heading[] {
  const lines = content.split('\n')
  const out: Heading[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^(#{1,6})\s+/.exec(lines[i])
    if (m) out.push({ line: i + 1, level: m[1].length })
  }
  return out
}

function sectionByteSize(
  content: string,
  lineStarts: number[],
  totalLines: number,
  s: RawSection,
): number {
  const start = lineStarts[s.startLine - 1]
  const end = s.endLine < totalLines ? lineStarts[s.endLine] : content.length
  return end - start
}

function sectionText(
  content: string,
  lineStarts: number[],
  totalLines: number,
  s: RawSection,
): { text: string; startPos: number } {
  const startPos = lineStarts[s.startLine - 1]
  let endPos: number
  if (s.endLine >= totalLines) {
    endPos = content.length
    // If the file ends with \n, exclude it so Block.text ends at content (not at the line terminator)
    if (endPos > startPos && content.charCodeAt(endPos - 1) === 10) endPos -= 1
  } else {
    // lineStarts[s.endLine] is the start of the line AFTER s.endLine, so the
    // position right before it (`- 1`) is the trailing \n of s.endLine.
    endPos = lineStarts[s.endLine] - 1
  }
  return { text: content.slice(startPos, endPos), startPos }
}

export function chunkDocumentSemantic(
  content: string,
  opts: SemanticChunkOptions = {},
): Block[] {
  const cutLevel = opts.cutLevel ?? 2
  const maxChars = opts.maxChars ?? 2400
  const minChars = opts.minChars ?? 400
  const windowChars = opts.windowChars ?? 800

  if (content.length === 0) return []

  const heads = findHeadings(content)
  // No headings at all → defer to size-bounded chunker.
  if (heads.length === 0) {
    return chunkDocument(content, maxChars, 0, windowChars)
  }
  // No headings at the requested cut level → defer to size-bounded chunker.
  const initialCuts = heads.filter((h) => h.level <= cutLevel)
  if (initialCuts.length === 0) {
    return chunkDocument(content, maxChars, 0, windowChars)
  }

  const lines = content.split('\n')
  const totalLines = lines.length
  const lineStarts = findLineStarts(content)

  // ---- Step 1: initial sections at cut level ----
  const sections: RawSection[] = []
  if (initialCuts[0].line > 1) {
    sections.push({ startLine: 1, endLine: initialCuts[0].line - 1, depth: 0 })
  }
  for (let i = 0; i < initialCuts.length; i++) {
    sections.push({
      startLine: initialCuts[i].line,
      endLine: i + 1 < initialCuts.length ? initialCuts[i + 1].line - 1 : totalLines,
      depth: initialCuts[i].level,
    })
  }

  // ---- Step 2: recursive heading-driven split for oversized sections ----
  let work = sections.slice()
  for (let depth = cutLevel + 1; depth <= 6; depth++) {
    const next: RawSection[] = []
    let didSplit = false
    for (const s of work) {
      if (sectionByteSize(content, lineStarts, totalLines, s) <= maxChars) {
        next.push(s)
        continue
      }
      const subs = heads.filter((h) =>
        h.level === depth && h.line >= s.startLine && h.line <= s.endLine,
      )
      if (subs.length === 0) { next.push(s); continue }
      didSplit = true
      // Preamble (text between section start and the first sub-heading, if any)
      if (subs[0].line > s.startLine) {
        next.push({ startLine: s.startLine, endLine: subs[0].line - 1, depth: s.depth })
      }
      for (let i = 0; i < subs.length; i++) {
        next.push({
          startLine: subs[i].line,
          endLine: i + 1 < subs.length ? subs[i + 1].line - 1 : s.endLine,
          depth,
        })
      }
    }
    work = next
    if (!didSplit) break
  }

  // ---- Step 3: size-fallback for sections still too big with no deeper headings ----
  const flattened: RawSection[] = []
  for (const s of work) {
    const size = sectionByteSize(content, lineStarts, totalLines, s)
    if (size <= maxChars) { flattened.push(s); continue }
    const { text, startPos } = sectionText(content, lineStarts, totalLines, s)
    const subBlocks = chunkDocument(text, maxChars, 0, windowChars)
    // Convert sub-block coordinates back to absolute lines/positions.
    for (const sb of subBlocks) {
      const absPos = startPos + sb.src_pos
      // Count newlines in [0, absPos) of the full content
      let absLine = 1
      for (let i = 0; i < absPos; i++) if (content.charCodeAt(i) === 10) absLine++
      // End line: absLine plus number of \n in this sub-block's text
      const subNl = (sb.text.match(/\n/g) ?? []).length
      flattened.push({
        startLine: absLine,
        endLine: absLine + subNl,
        depth: s.depth,
      })
    }
  }

  // ---- Step 4: merge undersized sections forward into the previous one ----
  const merged: RawSection[] = []
  for (const s of flattened) {
    if (
      merged.length > 0 &&
      sectionByteSize(content, lineStarts, totalLines, s) < minChars
    ) {
      const last = merged[merged.length - 1]
      merged[merged.length - 1] = {
        startLine: last.startLine,
        endLine: s.endLine,
        depth: Math.min(last.depth, s.depth),
      }
    } else {
      merged.push(s)
    }
  }
  // Tail-merge: if the very last section is still small, fold it backward.
  if (merged.length >= 2) {
    const tail = merged[merged.length - 1]
    if (sectionByteSize(content, lineStarts, totalLines, tail) < minChars) {
      const prev = merged[merged.length - 2]
      merged[merged.length - 2] = {
        startLine: prev.startLine,
        endLine: tail.endLine,
        depth: Math.min(prev.depth, tail.depth),
      }
      merged.pop()
    }
  }

  // ---- Step 5: emit Block[] ----
  const out: Block[] = []
  for (const s of merged) {
    const { text, startPos } = sectionText(content, lineStarts, totalLines, s)
    out.push({ text, src_pos: startPos, src_line: s.startLine })
  }
  return out
}
