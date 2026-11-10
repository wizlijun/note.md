import { describe, expect, it } from 'vitest'
import type { EvidenceItem, EvidenceStepResult } from './api'
import {
  absolutePath, addTotals, answerParts, applyPending, applyRound, emptyEvidence, emptyTotals, evidenceNotice, headerFromStep, restoreRound,
  roundLabel, shouldStartEvidence, startOffered,
} from './evidence-flow'
import { DEFAULT_SMART_LOOKUP_SETTINGS, normalizeSmartLookupSettings } from './settings'
import { en } from '../i18n/en'
import { zh } from '../i18n/zh'

const item = (id: string, foundRound: number, tier: EvidenceItem['tier'] = 'fit'): EvidenceItem => ({
  evidenceId: id, path: `${id}.md`, line: 1, lineEnd: 2, title: id, breadcrumb: '', text: id, foundRound, tier, localResultId: null,
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
  it('a failed round keeps the list waiting for Apply and records the stop', () => {
    const waiting = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b']), false), round(1, ['c', 'a']), true)
    const v = applyRound(waiting, round(2, [], { status: 'skipped', stop: 'indexChanged', done: true }), true)
    expect(ids(v.pending!)).toEqual(['c', 'a']); expect(ids(v.shown)).toEqual(['a', 'b', 'c'])
    expect(v.stop).toBe('indexChanged'); expect(v.done).toBe(true)
    const timedOut = applyRound(waiting, round(2, [], { status: 'timeout' }), true)
    expect(ids(timedOut.pending!)).toEqual(['c', 'a']); expect(timedOut.stop).toBeNull()
  })
  it('a stop that scored nothing reports the shown list again without adding a round', () => {
    // The host repeats the last scored evidence with the stop (Task 8 `report_shown`).
    const shown = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b']), false), round(1, ['c', 'a']), false)
    const v = applyRound(shown, round(2, ['c', 'a'], { done: true, stop: 'budget' }), true)
    expect(v.rounds.map((r) => r.hop)).toEqual([0, 1]); expect(ids(v.shown)).toEqual(['c', 'a'])
    expect(v.pending).toBeNull(); expect(v.stop).toBe('budget'); expect(v.done).toBe(true)
  })
  it('the first round shows its list as is even after the user moved', () => {
    const v = applyRound(emptyEvidence(), round(0, ['a', 'b']), true)
    expect(ids(v.shown)).toEqual(['a', 'b']); expect(v.pending).toBeNull()
  })
  it('a round in the order already shown leaves nothing to apply', () => {
    const v = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b']), false), round(1, ['a', 'b', 'c']), true)
    expect(ids(v.shown)).toEqual(['a', 'b', 'c']); expect(v.pending).toBeNull()
  })
  it('a second result for the same hop replaces that round\'s snapshot', () => {
    const v = applyRound(applyRound(emptyEvidence(), round(0, ['a']), false), round(0, ['b', 'c']), false)
    expect(v.rounds).toHaveLength(1); expect(ids(v.rounds[0].items)).toEqual(['b', 'c']); expect(ids(v.shown)).toEqual(['b', 'c'])
  })
  it('restoring a round drops the list waiting for Apply', () => {
    const waiting = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b']), false), round(1, ['c', 'a']), true)
    const v = restoreRound(waiting, 0)
    expect(ids(v.shown)).toEqual(['a', 'b']); expect(v.pending).toBeNull()
  })
  it('names the end of a run: budget, index change, or no evidence', () => {
    const done = (extra: Partial<EvidenceStepResult>, items: string[] = []) => applyRound(emptyEvidence(), round(0, items, { done: true, ...extra }), false)
    expect(evidenceNotice(done({ stop: 'maxHops' }))).toBe('smartSearch.evidence.none')
    expect(evidenceNotice(done({ stop: 'noTerms', status: 'skipped' }))).toBe('smartSearch.evidence.none')
    expect(evidenceNotice(done({ stop: 'maxHops' }, ['a']))).toBeNull()
    expect(evidenceNotice(done({ stop: 'budget' }))).toBe('smartSearch.evidence.budget')
    expect(evidenceNotice(done({ stop: 'evidenceTooLarge', status: 'skipped' }))).toBe('smartSearch.evidence.tooLarge')
    expect(evidenceNotice(done({ stop: 'indexChanged', status: 'skipped' }, ['a']))).toBe('smartSearch.evidence.indexChanged')
    // A failed round says so in the status line; it is not "no evidence".
    expect(evidenceNotice(done({ status: 'timeout', done: false }))).toBeNull()
    expect(evidenceNotice(emptyEvidence())).toBeNull()
  })
  it('a run whose evidence is all unfit found no evidence; one fit or unsure item is evidence', () => {
    const finished = (tiers: EvidenceItem['tier'][], extra: Partial<EvidenceStepResult> = { done: true, stop: 'maxHops' }) =>
      applyRound(emptyEvidence(), { ...round(0, []), ...extra, evidence: tiers.map((tier, i) => item(`i${i}`, 0, tier)) }, false)
    expect(evidenceNotice(finished(['unfit', 'unfit', 'unfit']))).toBe('smartSearch.evidence.none')
    expect(evidenceNotice(finished(['unfit', 'fit', 'unfit']))).toBeNull()
    expect(evidenceNotice(finished(['unsure', 'unfit']))).toBeNull()
    // Still running: no verdict yet.
    expect(evidenceNotice(finished(['unfit'], { done: false, stop: null }))).toBeNull()
  })
  it('sums what each call sent into run totals; the host only when something went to it', () => {
    const one = addTotals(emptyTotals(), round(0, ['a'], {
      requestCount: 2, elapsedMs: 300, sentBlocks: 12, estimatedTokens: 4000, skippedConfidential: 1, skippedStale: 2, skippedLong: 3,
      skippedOversize: 1, endpointHost: 'h.example',
    }))
    const two = addTotals(one, round(1, ['b'], {
      requestCount: 1, elapsedMs: 200, sentBlocks: 5, estimatedTokens: 1000, skippedConfidential: 2, endpointHost: 'h.example',
    }))
    expect(two).toEqual({ host: 'h.example', requests: 3, elapsedMs: 500, sent: 17, tokens: 5000, confidential: 3, stale: 2, long: 4 })
    const nothingSent = addTotals(emptyTotals(), round(0, [], { status: 'noConsent', requestCount: 0, sentBlocks: 0, estimatedTokens: 0, endpointHost: 'x.example' }))
    expect(nothingSent.host).toBeNull(); expect(nothingSent.tokens).toBe(0)
  })
  it('opens evidence by the vault root that the local hits show', () => {
    const hits = [{ path: 'notes/a.md', absPath: '/vault/notes/a.md' }]
    expect(absolutePath('notes/a.md', hits)).toBe('/vault/notes/a.md')
    expect(absolutePath('other/b.md', hits)).toBe('/vault/other/b.md')
    expect(absolutePath('other/b.md', [{ path: 'notes/a.md', absPath: 'C:\\vault\\notes\\a.md' }])).toBe('C:\\vault\\other\\b.md')
    expect(absolutePath('other/b.md', [{ path: 'notes/a.md', absPath: '/elsewhere/x.md' }])).toBeNull()
    expect(absolutePath('other/b.md', [])).toBeNull()
  })
  it('records the stop reason when the run finishes', () => {
    const v = applyRound(emptyEvidence(), round(2, ['a'], { done: true, stop: 'maxHops' }), false)
    expect(v.done).toBe(true); expect(v.stop).toBe('maxHops')
  })
  it('maps a step to the status line: host and status class only', () => {
    expect(headerFromStep(round(0, ['a']))).toEqual({ kind: 'none' })
    expect(headerFromStep(round(0, [], { status: 'skipped', skipReason: 'fewTerms' }))).toEqual({ kind: 'none' })
    expect(headerFromStep(round(0, [], { status: 'skipped', skipReason: 'indexUnavailable' }))).toEqual({ kind: 'indexUnavailable' })
    expect(headerFromStep(round(1, [], { status: 'keyInvalid', endpointHost: 'h.example', statusClass: '4xx' })))
      .toEqual({ kind: 'degraded', status: 'keyInvalid', host: 'h.example', statusClass: '4xx', missing: null })
    expect(headerFromStep(round(0, [], { status: 'notConfigured', missing: 'key' })))
      .toEqual({ kind: 'degraded', status: 'notConfigured', host: null, statusClass: null, missing: 'key' })
  })
  it('offers a user start when the host did not start on its own', () => {
    for (const skipReason of ['pinned', 'fewTerms', 'autoBudgetUsed'] as const) {
      expect(startOffered(round(0, [], { status: 'skipped', skipReason, done: true }))).toBe(true)
    }
    for (const skipReason of ['indexUnavailable', 'zeroHits', 'roundRunning'] as const) {
      expect(startOffered(round(0, [], { status: 'skipped', skipReason, done: true }))).toBe(false)
    }
    expect(startOffered(round(0, ['a']))).toBe(false)
    expect(startOffered(round(0, [], { status: 'timeout', done: true }))).toBe(false)
  })
  it('labels rounds', () => {
    expect(roundLabel(0)).toBe('smartSearch.evidence.round.local')
    expect(roundLabel(1)).toBe('smartSearch.evidence.round.one')
    expect(roundLabel(2)).toBe('smartSearch.evidence.round.two')
  })
  it('round labels read as expansions (H.8)', () => {
    expect([zh, en].map((c) => [c['smartSearch.evidence.round.one'], c['smartSearch.evidence.round.two']]))
      .toEqual([['第 1 轮扩展', '第 2 轮扩展'], ['Expansion 1', 'Expansion 2']])
  })
  it('starts automatically only with hits, a judge route and a consented endpoint', () => {
    const s = normalizeSmartLookupSettings({ enhance: { jev: { url: 'https://a.example/v1', model: 'm', consentHost: 'a.example' } } })
    expect(shouldStartEvidence(3, 'judge', s)).toBe(true)
    // Only `skip` blocks a route; the window passes `judge` whenever it has hits.
    expect(shouldStartEvidence(3, 'repair', s)).toBe(true)
    // Zero hits take the repair route (F.5, F.6), never evidence.
    expect(shouldStartEvidence(0, 'repair', s)).toBe(false)
    expect(shouldStartEvidence(0, 'judge', s)).toBe(false)
    expect(shouldStartEvidence(3, 'skip', s)).toBe(false)
    expect(shouldStartEvidence(3, 'judge', normalizeSmartLookupSettings({ enhance: { jev: { ...s.enhance.jev, consentHost: 'b.example' } } }))).toBe(false)
    expect(shouldStartEvidence(3, 'judge', DEFAULT_SMART_LOOKUP_SETTINGS)).toBe(false)
  })
})

describe('answerParts', () => {
  const sources = [{ id: 1, evidenceId: 'e1' }, { id: 2, evidenceId: 'e2' }]

  it('links source labels and keeps everything else as plain text', () => {
    expect(answerParts('A [1] and <i>b</i> [1, 2]，[1，2]', sources)).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'cite', text: '[1]', id: 1, evidenceId: 'e1' },
      { kind: 'text', text: ' and <i>b</i> [' },
      { kind: 'cite', text: '1', id: 1, evidenceId: 'e1' },
      { kind: 'text', text: ', ' },
      { kind: 'cite', text: '2', id: 2, evidenceId: 'e2' },
      { kind: 'text', text: ']，[' },
      { kind: 'cite', text: '1', id: 1, evidenceId: 'e1' },
      { kind: 'text', text: '，' },
      { kind: 'cite', text: '2', id: 2, evidenceId: 'e2' },
      { kind: 'text', text: ']' },
    ])
  })

  it('leaves Markdown links, definitions and unknown numbers as text', () => {
    expect(answerParts('[1](http://x) [2]: y [9] [1, 9]', sources)).toEqual([
      { kind: 'text', text: '[1](http://x) [2]: y [9] [' },
      { kind: 'cite', text: '1', id: 1, evidenceId: 'e1' },
      { kind: 'text', text: ', 9]' },
    ])
    expect(answerParts('no labels', sources)).toEqual([{ kind: 'text', text: 'no labels' }])
    expect(answerParts('', sources)).toEqual([])
  })
})
