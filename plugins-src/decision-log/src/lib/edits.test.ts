import { describe, it, expect } from 'vitest'
import { applyNote, applyAdjustCheckDate, applyDrop, markConsumed } from './edits'
import type { OpenDecision } from './model'

const base: OpenDecision = {
  id: '2026-07-07-01', title: 'MVP', prediction: '两周内发出', confidence: 'medium',
  'check-date': '2026-08-04', created: '2026-07-07', origin: 'agent', strikes: 0,
}
const other: OpenDecision = { ...base, id: '2026-07-07-02', title: 'CDN' }

describe('applyNote', () => {
  it('appends a progress note to the matched decision', () => {
    const out = applyNote([base, other], '2026-07-07-01', '2026-07-25', '进度过半')
    expect(out[0].progress).toEqual([{ date: '2026-07-25', text: '进度过半' }])
    expect(out[1].progress).toBeUndefined()
  })
  it('appends onto existing progress without mutating input', () => {
    const seeded: OpenDecision = { ...base, progress: [{ date: '2026-07-20', text: '起步' }] }
    const out = applyNote([seeded], '2026-07-07-01', '2026-07-25', '进度过半')
    expect(out[0].progress).toHaveLength(2)
    expect(seeded.progress).toHaveLength(1) // input untouched
  })
  it('returns input unchanged when id not found', () => {
    const out = applyNote([base], 'nope', '2026-07-25', 'x')
    expect(out).toEqual([base])
  })
})

describe('applyAdjustCheckDate', () => {
  it('updates check-date on the matched decision', () => {
    const out = applyAdjustCheckDate([base, other], '2026-07-07-01', '2026-09-01')
    expect(out[0]['check-date']).toBe('2026-09-01')
    expect(out[1]['check-date']).toBe('2026-08-04')
    expect(base['check-date']).toBe('2026-08-04') // input untouched
  })
  it('returns input unchanged when id not found', () => {
    expect(applyAdjustCheckDate([base], 'nope', '2026-09-01')).toEqual([base])
  })
})

describe('applyDrop', () => {
  it('removes from open and produces a dropped ArchivedDecision', () => {
    const r = applyDrop([base, other], '2026-07-07-01', '2026-07-25')
    expect(r.open.map((d) => d.id)).toEqual(['2026-07-07-02'])
    expect(r.archived).toMatchObject({
      id: '2026-07-07-01', created: '2026-07-07', status: 'dropped',
      prediction: '两周内发出', confidence: 'medium', origin: 'agent',
    })
    // dropped 不进命中统计:不带 outcome/still-endorse
    expect(r.archived.outcome).toBeUndefined()
    expect(r.archived['still-endorse']).toBeUndefined()
  })
  it('carries state snapshot when present', () => {
    const withState: OpenDecision = { ...base, state: { time: 'morning' } }
    const r = applyDrop([withState], '2026-07-07-01', '2026-07-25')
    expect(r.archived.state).toEqual({ time: 'morning' })
  })
  it('throws when id not found', () => {
    expect(() => applyDrop([base], 'nope', '2026-07-25')).toThrow()
  })
})

describe('markConsumed', () => {
  const file = JSON.stringify({
    date: '2026-07-21',
    new_candidates: [
      { id: 'a', title: 'A', prediction_source: 'nominated', status: 'pending' },
      { id: 'a', title: 'A2', prediction_source: 'nominated', status: 'pending' },
    ],
    closures: [{ decision_id: 'x', reason: 'due', status: 'pending' }],
    edit_decisions: [
      { decision_id: 'e', kind: 'progress', summary: 's', suggested_action: 'note', status: 'accepted' },
      { decision_id: 'e', kind: 'progress', summary: 's2', suggested_action: 'note', status: 'pending' },
    ],
  })

  it('marks first pending new_candidate by id as accepted', () => {
    const out = JSON.parse(markConsumed(file, 'new_candidates', 'a', 'accepted'))
    expect(out.new_candidates[0].status).toBe('accepted')
    expect(out.new_candidates[1].status).toBe('pending') // only first
  })
  it('marks closure by decision_id as dismissed', () => {
    const out = JSON.parse(markConsumed(file, 'closures', 'x', 'dismissed'))
    expect(out.closures[0].status).toBe('dismissed')
  })
  it('marks first pending edit_decision by decision_id, skipping already-consumed', () => {
    const out = JSON.parse(markConsumed(file, 'edit_decisions', 'e', 'accepted'))
    expect(out.edit_decisions[0].status).toBe('accepted') // already accepted, untouched
    expect(out.edit_decisions[1].status).toBe('accepted') // first pending flipped
  })
  it('returns json unchanged when key not found', () => {
    expect(markConsumed(file, 'closures', 'zzz', 'accepted')).toBe(file)
  })
  it('returns json unchanged on parse failure', () => {
    expect(markConsumed('not json', 'closures', 'x', 'accepted')).toBe('not json')
  })
})
