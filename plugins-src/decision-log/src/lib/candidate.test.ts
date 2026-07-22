import { describe, it, expect } from 'vitest'
import { parseCandidateFile, type EditDecision } from './candidate'

const good = JSON.stringify({
  date: '2026-07-21', generated_by: 'openclaw',
  new_candidates: [
    { id: 'cand-2026-07-21-01', title: 'MVP', prediction_source: 'quoted',
      quote: '两周内能发', prediction: '两周内发出 MVP', confidence: 'medium',
      check_date: '2026-08-04', status: 'pending' },
    { id: 'cand-2026-07-21-02', title: '换 CDN', prediction_source: 'nominated',
      prediction: '你是预期延迟减半吗?', confidence: null, status: 'pending' },
  ],
  closures: [
    { decision_id: '2026-07-07-01', reason: 'due', suggested_outcome: 'hit',
      evidence: [{ quote: '上线了' }], status: 'pending' },
  ],
})

describe('parseCandidateFile', () => {
  it('parses valid file', () => {
    const r = parseCandidateFile(good)
    expect(r.new_candidates).toHaveLength(2)
    expect(r.closures).toHaveLength(1)
  })
  it('drops quoted candidate missing quote (invalid), keeps rest', () => {
    const bad = JSON.stringify({ date: '2026-07-21', generated_by: 'x',
      new_candidates: [{ id: 'cand-2026-07-21-01', title: 'X', prediction_source: 'quoted', status: 'pending' }],
      closures: [] })
    expect(parseCandidateFile(bad).new_candidates).toHaveLength(0)
  })
  it('throws on non-JSON', () => {
    expect(() => parseCandidateFile('not json')).toThrow()
  })

  it('parses edit_decisions, validates decision_id/kind/suggested_action', () => {
    const raw = JSON.stringify({
      date: '2026-07-21',
      new_candidates: [], closures: [],
      edit_decisions: [
        { decision_id: '2026-07-07-01', kind: 'progress', summary: '进度过半',
          suggested_action: 'note', status: 'pending' },
        { decision_id: '2026-07-07-02', kind: 'resolved', summary: '已达成',
          suggested_action: 'close-hit', evidence: [{ quote: '上线了' }], status: 'pending' },
        { decision_id: '2026-07-07-03', kind: 'progress', summary: '延后',
          suggested_action: 'adjust-check-date', new_check_date: '2026-09-01', status: 'pending' },
        // invalid: empty decision_id
        { decision_id: '', kind: 'progress', summary: 'x', suggested_action: 'note' },
        // invalid: bad kind
        { decision_id: 'd', kind: 'nope', summary: 'x', suggested_action: 'note' },
        // invalid: bad suggested_action
        { decision_id: 'd', kind: 'progress', summary: 'x', suggested_action: 'explode' },
      ],
    })
    const r = parseCandidateFile(raw)
    expect(r.edit_decisions).toHaveLength(3)
    const first = r.edit_decisions[0] as EditDecision
    expect(first).toMatchObject({ decision_id: '2026-07-07-01', kind: 'progress', suggested_action: 'note' })
    expect(r.edit_decisions[2].new_check_date).toBe('2026-09-01')
  })

  it('edit_decisions defaults to [] when absent', () => {
    expect(parseCandidateFile(JSON.stringify({ date: 'd', new_candidates: [], closures: [] })).edit_decisions).toEqual([])
  })

  it('only keeps pending (or missing status) items across all three arrays', () => {
    const raw = JSON.stringify({
      date: '2026-07-21',
      new_candidates: [
        { id: 'a', title: 'A', prediction_source: 'nominated', status: 'pending' },
        { id: 'b', title: 'B', prediction_source: 'nominated', status: 'accepted' },
        { id: 'c', title: 'C', prediction_source: 'nominated' }, // missing = kept
        { id: 'd', title: 'D', prediction_source: 'nominated', status: 'dismissed' },
      ],
      closures: [
        { decision_id: 'x', reason: 'due', status: 'pending' },
        { decision_id: 'y', reason: 'due', status: 'accepted' },
        { decision_id: 'z', reason: 'due' }, // missing = kept
      ],
      edit_decisions: [
        { decision_id: 'e1', kind: 'progress', summary: 's', suggested_action: 'note', status: 'pending' },
        { decision_id: 'e2', kind: 'progress', summary: 's', suggested_action: 'note', status: 'dismissed' },
        { decision_id: 'e3', kind: 'progress', summary: 's', suggested_action: 'note' }, // missing = kept
      ],
    })
    const r = parseCandidateFile(raw)
    expect(r.new_candidates.map((c) => c.id)).toEqual(['a', 'c'])
    expect(r.closures.map((c) => c.decision_id)).toEqual(['x', 'z'])
    expect(r.edit_decisions.map((c) => c.decision_id)).toEqual(['e1', 'e3'])
  })
})
