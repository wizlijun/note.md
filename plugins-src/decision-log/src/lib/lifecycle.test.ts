import { describe, it, expect } from 'vitest'
import { sign, verdict, incStrike, manualCreate } from './lifecycle'
import type { OpenDecision } from './model'

const base: OpenDecision = {
  id: '2026-07-21-01', title: 'MVP', prediction: '两周内发出', confidence: 'medium',
  'check-date': '2026-08-04', created: '2026-07-21', origin: 'manual', strikes: 0,
}

describe('lifecycle', () => {
  it('sign appends a new open decision + create event', () => {
    const r = sign([], {
      title: 'MVP', prediction: '两周内发出', confidence: 'medium',
      checkDate: '2026-08-04', origin: 'agent', created: '2026-07-21', source_conv: 'cv1',
    })
    expect(r.open).toHaveLength(1)
    expect(r.open[0].id).toBe('2026-07-21-01')
    expect(r.event).toMatchObject({ event: 'create', id: '2026-07-21-01', confidence: 'medium' })
  })
  it('verdict moves decision out of open into archived + verdict event', () => {
    const r = verdict([base], '2026-07-21-01', { outcome: 'hit', stillEndorse: true, resolved: '2026-08-04', evidence: [] })
    expect(r.open).toHaveLength(0)
    expect(r.archived).toMatchObject({ id: '2026-07-21-01', status: 'closed', outcome: 'hit', 'still-endorse': true })
    expect(r.event).toMatchObject({ event: 'verdict', outcome: 'hit', still_endorse: true })
  })
  it('incStrike bumps strikes; at 3 downgrades into archive', () => {
    const two = { ...base, strikes: 2 }
    const r = incStrike([two], '2026-07-21-01', '2026-08-25')
    expect(r.open).toHaveLength(0)
    expect(r.archived).toMatchObject({ status: 'downgraded' })
    expect(r.event).toMatchObject({ event: 'downgrade', id: '2026-07-21-01' })
  })
  it('incStrike below 3 keeps it open with strikes+1, no archive', () => {
    const r = incStrike([base], '2026-07-21-01', '2026-08-25')
    expect(r.open[0].strikes).toBe(1)
    expect(r.archived).toBeUndefined()
  })
})
