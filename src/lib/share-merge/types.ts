export const MERGE_KERNEL_VERSION = 1

export interface Token {
  text: string
  start: number
  end: number
  fmKey?: string
  fmAtomic?: true
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

export type HunkDecision =
  | { kind: 'theirs-only'; choice: 'accept' | 'reject' }
  | { kind: 'conflict'; choice: 'ours' | 'theirs' | 'ours+theirs' | 'theirs+ours' | 'edited'; text?: string; source?: 'human' | 'ai-suggestion' }

export interface ComposeResult {
  text: string
  pendingConflicts: string[]
  pendingTheirs: string[]
  accepted: number
  total: number
  staleDecisions: string[]
}

export interface TextSelector {
  exact: string
  prefix?: string
  suffix?: string
  start?: number
  end?: number
}

export type AnchorResult = { status: 'exact' | 'fuzzy'; start: number; end: number } | { status: 'orphan' }

export interface ExtractResult {
  clean: string
  annotations: { selector: TextSelector; comment: string; kind: 'comment' }[]
  ownerAnnotationsTouched: string[]
}

export interface RebaseResult {
  proposal: MergeProposal
  text: string
  conflicts: string[]
  ownerAnnotationTouched: boolean
}
