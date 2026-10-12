import type { OwnerAnnotation } from './critic'
import type { HunkFlag, Token } from './types'

const flagOrder: HunkFlag[] = ['trust-field', 'frontmatter', 'owner-annotation', 'hidden-chars', 'eol-only', 'degraded']
const trustKeys = new Set(['type', 'generated', 'verified', 'sources', 'status', 'stale_after'])
// Reviewed bidi controls and zero-width characters, including embedded BOM.
const hiddenChars = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu

export { scanOwnerAnnotations } from './critic'

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
