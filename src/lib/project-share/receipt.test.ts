import { expect, it } from 'vitest'
import type { LocalFeedback, Decision } from './types'
import { buildProjectReceipt } from './receipt'
const at = '2026-10-13T00:00:00Z'
function item(decisions: Record<string, Decision> = {}, status = 'pending'): LocalFeedback {
  return { envelope: { payload: { schemaVersion: 2, project_id: 'p', snapshotId: 's', submissionId: 'sub', message: 'SECRET_BODY',
    edits: Object.keys(decisions).map(path => ({ path, baseHash: 'SECRET_BODY', afterMarkdown: 'SECRET_BODY' })),
    annotations: [{ path: 'a.md', selector: { exact: 'SECRET_BODY' }, comment: 'SECRET_BODY' }] }, requestHash: 'SECRET_BODY', receivedAt: at },
    status, decisions, annotation_decisions: { '0': 'promoted', '99': 'promoted', '01': 'promoted' } }
}
it.each([
  ['accepted', { status: 'accepted' }, 'accepted', 1, 1],
  ['partial', { status: 'accepted', hunkSummary: { accepted: 2, total: 3 } }, 'partial', 2, 3],
  ['rejected', { status: 'rejected' }, 'rejected', 0, 1],
  ['superseded', { status: 'rejected', reason: 'superseded' }, 'superseded', 0, 1],
  ['branched', { status: 'branched' }, 'forwarded', 0, 1],
  ['mirror', { status: 'mirror_pending' }, 'accepted', 1, 1],
  ['zero', { status: 'accepted', hunkSummary: { accepted: 0, total: 0 } }, 'accepted', 0, 0],
] as const)('derives %s using only receipt fields', (_, decision, outcome, accepted, total) => {
  const f = item({ 'a.md': decision }); f.receipt = { state: 'auto', reply: '谢谢' }
  const receipt = buildProjectReceipt(f, at, 'new-s')!
  expect(receipt).toEqual({ schemaVersion: 1, project_id: 'p', submissionId: 'sub', decidedAt: at, outcome,
    files: [{ path: 'a.md', outcome: outcome === 'superseded' ? 'rejected' : outcome, accepted, total }], annotations: { promoted: 1, total: 1 }, reply: '谢谢', includedInSnapshotId: 'new-s' })
  expect(JSON.stringify(receipt)).not.toMatch(/SECRET_BODY|afterMarkdown|quote|selector|baseHash|current|content|git|commit|token|source/)
})
it.each(['pending', 'recovery_conflict', 'not_applied'])('does not send incomplete %s', status => {
  expect(buildProjectReceipt(item({ 'a.md': { status } }), at)).toBeNull()
})
it('requires resolved for empty edits and rejects quarantine even with terminal decisions', () => {
  expect(buildProjectReceipt(item(), at)).toBeNull()
  expect(buildProjectReceipt(item({}, 'resolved'), at)?.outcome).toBe('accepted')
  expect(buildProjectReceipt(item({ 'a.md': { status: 'accepted' } }, 'quarantined'), at)).toBeNull()
})
it('derives mixed branch outcomes', () => {
  expect(buildProjectReceipt(item({ a: { status: 'branched' }, b: { status: 'rejected' } }), at)?.outcome).toBe('forwarded')
  expect(buildProjectReceipt(item({ a: { status: 'branched' }, b: { status: 'accepted' } }), at)?.outcome).toBe('partial')
  const missing = item({ a: { status: 'accepted' } }); missing.envelope.payload.edits.push({ path: 'b', baseHash: '', afterMarkdown: '' })
  expect(buildProjectReceipt(missing, at)).toBeNull()
})
