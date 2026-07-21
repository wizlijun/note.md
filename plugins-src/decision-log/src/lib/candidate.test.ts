import { describe, it, expect } from 'vitest'
import { parseCandidateFile } from './candidate'

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
})
