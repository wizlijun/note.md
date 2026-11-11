import { describe, expect, it } from 'vitest'
import type { EvidenceItem, EvidenceStepResult } from './api'
import {
  answerGate, answerParts, applyRound, confirmedCount, emptyEvidence, evidenceFinished, fitEvidence, headerFromStep,
  shouldStartEvidence, totalsOf,
} from './evidence-flow'
import { DEFAULT_SMART_LOOKUP_SETTINGS, normalizeSmartLookupSettings } from './settings'

const item = (id: string, foundRound: number, tier: EvidenceItem['tier'] = 'fit'): EvidenceItem => ({
  evidenceId: id, path: `${id}.md`, absPath: `/vault/${id}.md`, line: 1, lineEnd: 2, title: id, breadcrumb: '', text: id, foundRound, tier, localResultId: null,
})
const round = (hop: number, ids: string[], extra: Partial<EvidenceStepResult> = {}): EvidenceStepResult => ({
  status: 'ok', stop: null, skipReason: null, missing: null, endpointHost: null, statusClass: null, hop,
  terms: [{ term: 't', label: 'T', kind: 'word' }], evidence: ids.map((i) => item(i, hop)), localTiers: [], done: false,
  requestCount: 1, poolSize: 0, candidates: 0, sentBlocks: 0, skippedConfidential: 0, skippedStale: 0, skippedLong: 0,
  skippedOversize: 0, estimatedTokens: 0, tokensUsed: 0, usage: null, elapsedMs: 0, nextHop: hop + 1,
  run: { endpointHost: null, requests: 0, elapsedMs: 0, sentBlocks: 0, tokens: 0, skippedConfidential: 0, skippedStale: 0, skippedLong: 0, skippedOversize: 0 },
  ...extra,
})
const ids = (items: EvidenceItem[]) => items.map((i) => i.evidenceId)

describe('evidence view', () => {
  it('applies every scored round as it arrives', () => {
    const v = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b'])), round(1, ['c', 'a']))
    expect(ids(v.shown)).toEqual(['c', 'a']); expect(v.rounds.map((r) => r.hop)).toEqual([0, 1])
  })
  it('a failed round keeps the previous list and ends the run without a stop', () => {
    const v = applyRound(applyRound(emptyEvidence(), round(0, ['a'])), round(1, [], { status: 'timeout' }))
    expect(ids(v.shown)).toEqual(['a']); expect(v.done).toBe(true); expect(v.stop).toBeNull(); expect(v.rounds).toHaveLength(1)
    expect(evidenceFinished(v)).toBe(false)
  })
  it('a stop that scored nothing reports the shown list again without adding a round', () => {
    // The host repeats the last scored evidence with the stop (Task 8 `report_shown`).
    const shown = applyRound(applyRound(emptyEvidence(), round(0, ['a', 'b'])), round(1, ['c', 'a']))
    const v = applyRound(shown, round(2, ['c', 'a'], { done: true, stop: 'budget' }))
    expect(v.rounds.map((r) => r.hop)).toEqual([0, 1]); expect(ids(v.shown)).toEqual(['c', 'a'])
    expect(v.stop).toBe('budget'); expect(v.done).toBe(true)
  })
  it('a second result for the same hop replaces that round\'s snapshot', () => {
    const v = applyRound(applyRound(emptyEvidence(), round(0, ['a'])), round(0, ['b', 'c']))
    expect(v.rounds).toHaveLength(1); expect(ids(v.rounds[0].items)).toEqual(['b', 'c']); expect(ids(v.shown)).toEqual(['b', 'c'])
  })
  it('the run is finished only when the host says done with a stop other than an index change', () => {
    const done = (extra: Partial<EvidenceStepResult>) => applyRound(emptyEvidence(), round(0, ['a'], { done: true, ...extra }))
    expect(evidenceFinished(done({ stop: 'maxHops' }))).toBe(true)
    expect(evidenceFinished(done({ stop: 'budget' }))).toBe(true)
    expect(evidenceFinished(done({ stop: 'noTerms', status: 'skipped' }))).toBe(true)
    expect(evidenceFinished(done({ stop: 'indexChanged', status: 'skipped' }))).toBe(false)
    expect(evidenceFinished(done({ status: 'cancelled', stop: null }))).toBe(false)
    // A skipped route (few terms, pinned) ends without a stop: not finished, nothing to answer.
    expect(evidenceFinished(done({ status: 'skipped', skipReason: 'fewTerms', stop: null }))).toBe(false)
    expect(evidenceFinished(applyRound(emptyEvidence(), round(0, ['a'])))).toBe(false)
    expect(evidenceFinished(emptyEvidence())).toBe(false)
  })
  it('the answer is written from the fit evidence only, in the order shown', () => {
    const v = applyRound(emptyEvidence(), { ...round(0, []), evidence: [item('a', 0, 'unsure'), item('b', 0), item('c', 0, 'unfit'), item('d', 1)] })
    expect(ids(fitEvidence(v))).toEqual(['b', 'd'])
  })
  it('counts the fit items of the latest completed round', () => {
    expect(confirmedCount(emptyEvidence())).toBeNull()
    const first = applyRound(emptyEvidence(), { ...round(0, []), evidence: [item('a', 0), item('b', 0, 'unfit')] })
    expect(confirmedCount(first)).toBe(1)
    const second = applyRound(first, { ...round(1, []), evidence: [item('a', 0), item('c', 1), item('d', 1, 'unsure')] })
    expect(confirmedCount(second)).toBe(2)
    // A failed round adds nothing: the count stays the last completed round's.
    expect(confirmedCount(applyRound(second, round(2, [], { status: 'timeout' })))).toBe(2)
  })
  it('takes the run totals from the host, not from summing this call', () => {
    const result = round(1, ['b'], {
      requestCount: 1, elapsedMs: 200, sentBlocks: 5, estimatedTokens: 1000, skippedConfidential: 2, endpointHost: 'h.example',
      run: {
        endpointHost: 'h.example', requests: 3, elapsedMs: 500, sentBlocks: 14, tokens: 5000,
        skippedConfidential: 2, skippedStale: 1, skippedLong: 3, skippedOversize: 1,
      },
    })
    expect(totalsOf(result)).toEqual({ host: 'h.example', elapsedMs: 500, sent: 14, skippedConfidential: 2 })
    // A refused call reports the run so far; nothing sent means no host.
    const nothingSent = totalsOf(round(0, [], { status: 'noConsent', requestCount: 0, endpointHost: 'x.example' }))
    expect(nothingSent.host).toBeNull(); expect(nothingSent.sent).toBe(0)
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

describe('answerGate (ruling A)', () => {
  const chat = (partial: Record<string, unknown>, enhance: Record<string, unknown> = {}) =>
    normalizeSmartLookupSettings({ enhance: { ...enhance, chat: { url: 'https://chat.example/v1', model: 'small', consentHost: 'chat.example', ...partial } } })
  it('starts only with the answer model set up and its host allowed', () => {
    expect(answerGate(chat({}))).toEqual({ kind: 'start' })
    expect(answerGate(chat({ consentHost: '' }))).toEqual({ kind: 'noConsent', host: 'chat.example' })
    expect(answerGate(chat({ consentHost: 'other.example' }))).toEqual({ kind: 'noConsent', host: 'chat.example' })
    expect(answerGate(chat({ model: ' ' }))).toEqual({ kind: 'notConfigured' })
    expect(answerGate(chat({ url: 'not a url' }))).toEqual({ kind: 'notConfigured' })
    expect(answerGate(chat({}, { enabled: false }))).toEqual({ kind: 'notConfigured' })
    expect(answerGate(DEFAULT_SMART_LOOKUP_SETTINGS)).toEqual({ kind: 'notConfigured' })
  })
})

describe('answerParts', () => {
  const sources = [{ id: 1, evidenceId: 'e1' }, { id: 2, evidenceId: 'e2' }]

  it('turns each cited number into a chip and keeps everything else as plain text', () => {
    expect(answerParts('A [1] and <i>b</i> [1, 2]，[1，2]', sources)).toEqual([
      { kind: 'text', text: 'A ' },
      { kind: 'cite', text: '1', id: 1, evidenceId: 'e1' },
      { kind: 'text', text: ' and <i>b</i> ' },
      { kind: 'cite', text: '1', id: 1, evidenceId: 'e1' },
      { kind: 'cite', text: '2', id: 2, evidenceId: 'e2' },
      { kind: 'text', text: '，' },
      { kind: 'cite', text: '1', id: 1, evidenceId: 'e1' },
      { kind: 'cite', text: '2', id: 2, evidenceId: 'e2' },
    ])
    expect(answerParts('决定的[1][2]。', sources)).toEqual([
      { kind: 'text', text: '决定的' },
      { kind: 'cite', text: '1', id: 1, evidenceId: 'e1' },
      { kind: 'cite', text: '2', id: 2, evidenceId: 'e2' },
      { kind: 'text', text: '。' },
    ])
  })

  it('leaves Markdown links, definitions and unknown numbers as text', () => {
    expect(answerParts('[1](http://x) [2]: y [9] [1, 9]', sources)).toEqual([
      { kind: 'text', text: '[1](http://x) [2]: y [9] ' },
      { kind: 'cite', text: '1', id: 1, evidenceId: 'e1' },
      { kind: 'text', text: '[9]' },
    ])
    expect(answerParts('no labels', sources)).toEqual([{ kind: 'text', text: 'no labels' }])
  })

  it('leaves labels in code as text, as the host ignores them', () => {
    expect(answerParts('see `[1]` and [2]', sources)).toEqual([
      { kind: 'text', text: 'see `[1]` and ' },
      { kind: 'cite', text: '2', id: 2, evidenceId: 'e2' },
    ])
    expect(answerParts('```\n[1]\n``` [2]', sources)).toEqual([
      { kind: 'text', text: '```\n[1]\n``` ' },
      { kind: 'cite', text: '2', id: 2, evidenceId: 'e2' },
    ])
    // An unclosed fence runs to the end, as in the host.
    expect(answerParts('[1] ```x [2]', sources)).toEqual([
      { kind: 'cite', text: '1', id: 1, evidenceId: 'e1' },
      { kind: 'text', text: ' ```x [2]' },
    ])
    // The host looks ahead in the prose with code removed: `[1]` then `(` is a link there.
    expect(answerParts('[1]`x`(y) [2]`z`', sources)).toEqual([
      { kind: 'text', text: '[1]`x`(y) ' },
      { kind: 'cite', text: '2', id: 2, evidenceId: 'e2' },
      { kind: 'text', text: '`z`' },
    ])
    expect(answerParts('', sources)).toEqual([])
  })
})
