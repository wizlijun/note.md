import type { LocalFeedback, ProjectReceipt } from './types'

/** Public receipt projection: never copy a submission, decision or local metadata object. */
export function buildProjectReceipt(feedback: LocalFeedback, decidedAt: string, includedInSnapshotId?: string): ProjectReceipt | null {
  const payload = feedback.envelope.payload
  if (feedback.status === 'quarantined') return null
  if (!payload.edits.length && feedback.status !== 'resolved') return null
  const files: ProjectReceipt['files'] = []
  for (const edit of payload.edits) {
    const decision = feedback.decisions[edit.path]
    if (!decision || !['accepted', 'rejected', 'branched', 'mirror_pending'].includes(decision.status)) return null
    const acceptedDecision = ['accepted', 'mirror_pending'].includes(decision.status)
    const summary = decision.hunkSummary ?? { accepted: acceptedDecision ? 1 : 0, total: 1 }
    files.push({ path: edit.path, outcome: decision.status === 'branched' ? 'forwarded' : decision.status === 'rejected' ? 'rejected' : summary.accepted === summary.total ? 'accepted' : 'partial', accepted: summary.accepted, total: summary.total })
  }
  let outcome: ProjectReceipt['outcome'] = 'accepted'
  if (files.length) {
    if (files.every(file => file.outcome === 'rejected')) outcome = payload.edits.every(edit => feedback.decisions[edit.path].reason === 'superseded') ? 'superseded' : 'rejected'
    else if (files.every(file => file.outcome === 'accepted')) outcome = 'accepted'
    else if (files.some(file => file.outcome === 'forwarded') && !files.some(file => ['accepted', 'partial'].includes(file.outcome))) outcome = 'forwarded'
    else outcome = 'partial'
  }
  return { schemaVersion: 1, project_id: payload.project_id, submissionId: payload.submissionId, decidedAt, outcome, files,
    annotations: { promoted: payload.annotations.filter((_, index) => feedback.annotation_decisions?.[String(index)] === 'promoted').length, total: payload.annotations.length },
    ...(feedback.receipt?.reply ? { reply: feedback.receipt.reply } : {}), ...(includedInSnapshotId ? { includedInSnapshotId } : {}) }
}
