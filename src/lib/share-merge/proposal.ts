import { diff, DiffLimitError } from './diff'
import { mergeRegions } from './diff3'
import { alignEol } from './eol'
import { sha256Sync } from './hash'
import { hunkFlags, scanOwnerAnnotations } from './flags'
import { tokenize } from './tokenize'
import { MERGE_KERNEL_VERSION } from './types'
import type { Change, Hunk, HunkKind, MergeInput, MergeProposal, Token } from './types'

const MAX_TOKENS = 200_000

function classify(base: string, ours: string, theirs: string): HunkKind {
  return ours === base ? 'theirs-only' : theirs === base ? 'ours-only' : ours === theirs ? 'both-same' : 'conflict'
}

export function propose(input: MergeInput): MergeProposal {
  const { path, base, ours } = input
  const { theirs, aligned } = alignEol(base, input.theirs)
  const proposal: MergeProposal = {
    kernelVersion: MERGE_KERNEL_VERSION, path,
    baseHash: sha256Sync(base), oursHash: sha256Sync(ours), theirsHash: sha256Sync(theirs),
    theirsEolAligned: aligned, segments: [], hunks: [],
    stats: { 'theirs-only': 0, 'ours-only': 0, 'both-same': 0, conflict: 0 },
  }
  if (base === ours && base === theirs) {
    if (ours) proposal.segments.push({ type: 'stable', text: ours })
    return proposal
  }
  const ownerAnnotations = scanOwnerAnnotations(base)
  const ordinals = new Map<string, Map<string, number>>()
  const addHunk = (b: string, o: string, t: string, start: number, end: number, b0: number, b1: number, involvedTokens: Token[], degraded = false) => {
    let byTheirs = ordinals.get(b)
    if (!byTheirs) { byTheirs = new Map(); ordinals.set(b, byTheirs) }
    const ordinal = byTheirs.get(t) ?? 0
    byTheirs.set(t, ordinal + 1)
    const hunk: Hunk = {
      id: 'h_' + sha256Sync(`nmk1\0${path}\0${b}\0${t}\0${ordinal}`).slice(0, 16),
      kind: classify(b, o, t), base: b, ours: o, theirs: t, oursStart: start, oursEnd: end,
      ...hunkFlags({ base: b, ours: o, theirs: t, tokens: involvedTokens, baseStart: b0, baseEnd: b1, ownerAnnotations, degraded }),
    }
    proposal.hunks.push(hunk)
    proposal.segments.push({ type: 'hunk', id: hunk.id })
    proposal.stats[hunk.kind]++
  }
  const tokens = [base, ours, theirs].map(tokenize)
  const degrade = () => { addHunk(base, ours, theirs, 0, ours.length, 0, base.length, tokens.flat(), true); return proposal }
  if (tokens.some(side => side.length > MAX_TOKENS)) return degrade()
  let oursChanges: Change[]
  let theirsChanges: Change[]
  const texts = tokens.map(side => side.map(token => token.text))
  try {
    oursChanges = diff(texts[0], texts[1])
    theirsChanges = diff(texts[0], texts[2])
  } catch (error) {
    if (error instanceof DiffLimitError) return degrade()
    throw error
  }
  const position = (side: Token[], at: number, text: string) => side[at]?.start ?? text.length
  // Changed ranges include insertions at either boundary. Without a change on
  // this side, carry its cumulative token offset from all preceding regions.
  const range = (b0: number, b1: number, changes: Change[], offset: number): [number, number] => changes.length
    ? [changes[0].s0 - (changes[0].b0 - b0), changes[changes.length - 1].s1 + b1 - changes[changes.length - 1].b1]
    : [b0 + offset, b1 + offset]
  let oursOffset = 0
  let theirsOffset = 0
  let cursor = 0
  for (const region of mergeRegions(oursChanges, theirsChanges)) {
    const [o0, o1] = range(region.b0, region.b1, region.ours, oursOffset)
    const [t0, t1] = range(region.b0, region.b1, region.theirs, theirsOffset)
    const start = position(tokens[1], o0, ours)
    const end = position(tokens[1], o1, ours)
    if (start > cursor) proposal.segments.push({ type: 'stable', text: ours.slice(cursor, start) })
    addHunk(base.slice(position(tokens[0], region.b0, base), position(tokens[0], region.b1, base)), ours.slice(start, end),
      theirs.slice(position(tokens[2], t0, theirs), position(tokens[2], t1, theirs)), start, end,
      position(tokens[0], region.b0, base), position(tokens[0], region.b1, base),
      [...tokens[0].slice(region.b0, region.b1), ...tokens[1].slice(o0, o1), ...tokens[2].slice(t0, t1)])
    cursor = end
    oursOffset = o1 - region.b1
    theirsOffset = t1 - region.b1
  }
  if (cursor < ours.length) proposal.segments.push({ type: 'stable', text: ours.slice(cursor) })
  return proposal
}
