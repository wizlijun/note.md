import { compose } from './compose'
import { propose } from './proposal'
import type { HunkDecision, RebaseResult } from './types'

export function rebaseDraft(input: { path: string; oldBase: string; newBase: string; draft: string }): RebaseResult {
  const proposal = propose({ path: input.path, base: input.oldBase, ours: input.newBase, theirs: input.draft })
  const decisions: Record<string, HunkDecision> = Object.fromEntries(proposal.hunks
    .filter(hunk => hunk.kind === 'theirs-only')
    .map(hunk => [hunk.id, { kind: 'theirs-only', choice: 'accept' }]))
  const result = compose(proposal, decisions)
  return { proposal, text: result.text, conflicts: result.pendingConflicts,
    ownerAnnotationTouched: proposal.hunks.some(hunk => hunk.flags.includes('owner-annotation')) }
}
