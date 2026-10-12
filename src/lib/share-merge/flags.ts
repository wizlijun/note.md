import type { HunkFlag, Token } from './types'

const flagOrder: HunkFlag[] = ['trust-field', 'frontmatter', 'owner-annotation', 'hidden-chars', 'eol-only', 'degraded']
const trustKeys = new Set(['type', 'generated', 'verified', 'sources', 'status', 'stale_after'])
// Reviewed bidi controls and zero-width characters, including embedded BOM.
const hiddenChars = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu

export interface OwnerAnnotation {
  start: number
  end: number
  raw: string
  quote: string
  comment: string
}

// Raw CriticMarkup ranges only; extraction and ownership matching live separately.
export function scanOwnerAnnotations(text: string): OwnerAnnotation[] {
  const groups: { start: number; end: number; open: string; valid: boolean }[] = []
  const stack: { start: number; open: string; valid: boolean }[] = []
  // Scan delimiters once so malformed repeated openers cannot cause regex
  // backtracking over the remaining document for every opener.
  for (const match of text.matchAll(/\{==|==\}|\{>>|<<\}/g)) {
    let slashes = 0
    for (let i = match.index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
    if (slashes % 2) continue
    const marker = match[0]
    if (marker === '{==' || marker === '{>>') {
      if (stack.length) stack[stack.length - 1].valid = false
      stack.push({ start: match.index, open: marker, valid: true })
    } else if (stack.length) {
      const top = stack[stack.length - 1]
      if (marker !== (top.open === '{==' ? '==}' : '<<}')) { top.valid = false; continue }
      stack.pop()
      if (!stack.length) groups.push({ ...top, end: match.index + marker.length })
    }
  }
  const annotations: OwnerAnnotation[] = []
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    let comment = group
    let quote = ''
    if (group.open === '{==') {
      const next = groups[i + 1]
      if (!next || next.open !== '{>>' || next.start !== group.end) continue
      comment = next
      quote = text.slice(group.start + 3, group.end - 3)
      i++
    }
    if (!group.valid || !comment.valid) continue
    annotations.push({ start: group.start, end: comment.end, raw: text.slice(group.start, comment.end),
      quote, comment: text.slice(comment.start + 3, comment.end - 3) })
  }
  return annotations
}

function hasNewHiddenChars(base: string, theirs: string): boolean {
  const remaining = new Map<string, number>()
  for (const char of base.match(hiddenChars) ?? []) remaining.set(char, (remaining.get(char) ?? 0) + 1)
  for (const char of theirs.match(hiddenChars) ?? []) {
    const count = remaining.get(char) ?? 0
    if (count === 0) return true
    remaining.set(char, count - 1)
  }
  return false
}

export function hunkFlags(input: {
  base: string; ours: string; theirs: string
  tokens: Token[]
  baseStart: number; baseEnd: number
  ownerAnnotations: OwnerAnnotation[]
  degraded: boolean
}): { flags: HunkFlag[]; frontmatterKeys?: string[] } {
  const { base, ours, theirs, tokens, baseStart, baseEnd, ownerAnnotations, degraded } = input
  const keys = [...new Set(tokens.flatMap(token => token.fmKey === undefined ? [] : [token.fmKey]))].sort()
  const atomic = tokens.some(token => token.fmAtomic)
  const flags = new Set<HunkFlag>()
  if (keys.length || atomic) flags.add('frontmatter')
  if (atomic || keys.some(key => trustKeys.has(key))) flags.add('trust-field')
  if (ownerAnnotations.some(annotation => Math.max(baseStart, annotation.start) < Math.min(baseEnd, annotation.end))) flags.add('owner-annotation')
  if (hasNewHiddenChars(base, theirs)) flags.add('hidden-chars')
  const normalizeEol = (text: string) => text.replace(/\r\n?/g, '\n')
  if (ours !== theirs && normalizeEol(ours) === normalizeEol(theirs)) flags.add('eol-only')
  if (degraded) flags.add('degraded')
  return { flags: flagOrder.filter(flag => flags.has(flag)), ...(flags.has('frontmatter') ? { frontmatterKeys: keys } : {}) }
}
