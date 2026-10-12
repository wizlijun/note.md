export const MERGE_KERNEL_VERSION = 1

export interface Token {
  text: string
  start: number
  end: number
  fmKey?: string
}

export interface Change {
  b0: number
  b1: number
  s0: number
  s1: number
}

export type HunkKind = 'theirs-only' | 'ours-only' | 'both-same' | 'conflict'
export type HunkFlag = 'trust-field' | 'frontmatter' | 'owner-annotation' | 'hidden-chars' | 'eol-only' | 'degraded'

export interface Hunk {
  id: string
  kind: HunkKind
  base: string
  ours: string
  theirs: string
  oursStart: number
  oursEnd: number
  flags: HunkFlag[]
  frontmatterKeys?: string[]
}

export type Segment = { type: 'stable'; text: string } | { type: 'hunk'; id: string }

export interface MergeInput {
  path: string
  base: string
  ours: string
  theirs: string
}

export interface MergeProposal {
  kernelVersion: 1
  path: string
  baseHash: string
  oursHash: string
  theirsHash: string
  theirsEolAligned: boolean
  segments: Segment[]
  hunks: Hunk[]
  stats: Record<HunkKind, number>
}
