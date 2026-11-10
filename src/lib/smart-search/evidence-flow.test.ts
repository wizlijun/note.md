import { describe, expect, it } from 'vitest'
import type { EvidenceItem, EvidenceStepResult } from './api'
import { applyPending, applyRound, emptyEvidence, restoreRound, roundLabel, shouldStartEvidence } from './evidence-flow'
import { DEFAULT_SMART_LOOKUP_SETTINGS, normalizeSmartLookupSettings } from './settings'

const item = (id: string, foundRound: number): EvidenceItem => ({
  evidenceId: id, path: `${id}.md`, line: 1, lineEnd: 2, title: id, breadcrumb: '', text: id, foundRound, tier: 'fit', localResultId: null,
})
const round = (hop: number, ids: string[], extra: Partial<EvidenceStepResult> = {}): EvidenceStepResult => ({
  status: 'ok', stop: null, skipReason: null, missing: null, endpointHost: null, statusClass: null, hop,
  terms: [{ term: 't', label: 'T', kind: 'word' }], evidence: ids.map((i) => item(i, hop)), localTiers: [], done: false,
  requestCount: 1, poolSize: 0, candidates: 0, sentBlocks: 0, skippedConfidential: 0, skippedStale: 0, skippedLong: 0,
  skippedOversize: 0, estimatedTokens: 0, tokensUsed: 0, usage: null, elapsedMs: 0, ...extra,
})
const ids = (items: EvidenceItem[]) => items.map((i) => i.evidenceId)

describe('evidence view', () => {
  it('replaces the list when the user has not interacted', () => {
    const v = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b']), false), round(1, ['c', 'a']), false)
    expect(ids(v.shown)).toEqual(['c', 'a']); expect(v.pending).toBeNull()
  })
  it('keeps shown items in place and appends new ones while the user interacts', () => {
    const v = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b']), false), round(1, ['c', 'a']), true)
    expect(ids(v.shown)).toEqual(['a', 'b', 'c']); expect(ids(v.pending!)).toEqual(['c', 'a'])
    expect(ids(applyPending(v).shown)).toEqual(['c', 'a']); expect(applyPending(v).pending).toBeNull()
  })
  it('restores an earlier round without a request', () => {
    const v = applyRound(applyRound(emptyEvidence(), round(0, ['a']), false), round(1, ['b']), false)
    expect(ids(restoreRound(v, 0).shown)).toEqual(['a'])
    expect(restoreRound(v, 9)).toBe(v)
  })
  it('a failed round keeps the previous list', () => {
    const v = applyRound(applyRound(emptyEvidence(), round(0, ['a']), false), round(1, [], { status: 'timeout' }), false)
    expect(ids(v.shown)).toEqual(['a']); expect(v.done).toBe(true); expect(v.rounds).toHaveLength(1)
  })
  it('records the stop reason when the run finishes', () => {
    const v = applyRound(emptyEvidence(), round(2, ['a'], { done: true, stop: 'maxHops' }), false)
    expect(v.done).toBe(true); expect(v.stop).toBe('maxHops')
  })
  it('labels rounds', () => {
    expect(roundLabel(0)).toBe('smartSearch.evidence.round.local')
    expect(roundLabel(1)).toBe('smartSearch.evidence.round.one')
    expect(roundLabel(2)).toBe('smartSearch.evidence.round.two')
  })
  it('starts automatically only with hits, a judge route and a consented endpoint', () => {
    const s = normalizeSmartLookupSettings({ enhance: { jev: { url: 'https://a.example/v1', model: 'm', consentHost: 'a.example' } } })
    expect(shouldStartEvidence(3, 'judge', s)).toBe(true)
    expect(shouldStartEvidence(3, 'repair', s)).toBe(true)
    expect(shouldStartEvidence(0, 'judge', s)).toBe(false)
    expect(shouldStartEvidence(3, 'skip', s)).toBe(false)
    expect(shouldStartEvidence(3, 'judge', normalizeSmartLookupSettings({ enhance: { jev: { ...s.enhance.jev, consentHost: 'b.example' } } }))).toBe(false)
    expect(shouldStartEvidence(3, 'judge', DEFAULT_SMART_LOOKUP_SETTINGS)).toBe(false)
  })
})
