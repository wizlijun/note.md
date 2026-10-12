import type { ComposeResult, HunkDecision, HunkFlag, MergeProposal } from './types'

const bulkRisks: HunkFlag[] = ['trust-field', 'owner-annotation', 'hidden-chars', 'degraded']

export function acceptUnconflicted(p: MergeProposal): Record<string, HunkDecision> {
  return Object.fromEntries(p.hunks
    .filter(h => h.kind === 'theirs-only' && !h.flags.some(flag => bulkRisks.includes(flag)))
    .map(h => [h.id, { kind: 'theirs-only', choice: 'accept' }]))
}

export function compose(p: MergeProposal, decisions: Record<string, HunkDecision>): ComposeResult {
  const hunks = new Map(p.hunks.map(h => [h.id, h]))
  const result: ComposeResult = { text: '', pendingConflicts: [], pendingTheirs: [], accepted: 0, total: 0, staleDecisions: [] }
  for (const [id, decision] of Object.entries(decisions)) {
    if (hunks.get(id)?.kind !== decision.kind) result.staleDecisions.push(id)
  }
  const pieces: string[] = []
  for (const segment of p.segments) {
    if (segment.type === 'stable') { pieces.push(segment.text); continue }
    const hunk = hunks.get(segment.id)!
    const candidate = Object.hasOwn(decisions, hunk.id) ? decisions[hunk.id] : undefined
    const decision = candidate?.kind === hunk.kind ? candidate : undefined
    let text = hunk.ours
    if (hunk.kind === 'theirs-only') {
      result.total++
      if (!decision) result.pendingTheirs.push(hunk.id)
      else if (decision.kind === 'theirs-only' && decision.choice === 'accept') {
        text = hunk.theirs
        result.accepted++
      }
    } else if (hunk.kind === 'conflict') {
      result.total++
      if (!decision) result.pendingConflicts.push(hunk.id)
      else if (decision.kind === 'conflict') {
        switch (decision.choice) {
          case 'ours': break
          case 'theirs': text = hunk.theirs; break
          case 'ours+theirs': text = hunk.ours + hunk.theirs; break
          case 'theirs+ours': text = hunk.theirs + hunk.ours; break
          case 'edited':
            if (typeof decision.text !== 'string') throw new Error(`edited decision requires text: ${hunk.id}`)
            text = decision.text
            break
        }
        if (decision.choice !== 'ours') result.accepted++
      }
    }
    pieces.push(text)
  }
  result.text = pieces.join('')
  return result
}
