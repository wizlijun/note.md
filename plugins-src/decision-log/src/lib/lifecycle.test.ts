import { describe, it, expect } from 'vitest'
import { sign, verdict, incStrike, skip } from './lifecycle'
import type { OpenDecision } from './model'

const base: OpenDecision = {
  id: '2026-07-21-01', title: 'MVP', prediction: '两周内发出', confidence: 0.75,
  'check-date': '2026-08-04', created: '2026-07-21', origin: 'manual', strikes: 0,
}

describe('lifecycle', () => {
  it('sign appends a new open decision + create event', () => {
    const r = sign([], {
      title: 'MVP', prediction: '两周内发出', confidence: 0.75,
      checkDate: '2026-08-04', origin: 'agent', created: '2026-07-21', source_conv: 'cv1',
    })
    expect(r.open).toHaveLength(1)
    expect(r.open[0].id).toBe('2026-07-21-01')
    expect(r.event).toMatchObject({ event: 'create', id: '2026-07-21-01', confidence: 0.75 })
  })
  it('sign carries premortem + alternatives (locked fields)', () => {
    const r = sign([], {
      title: 'MVP', prediction: '两周内发出', confidence: 0.85,
      checkDate: '2026-08-04', origin: 'manual', created: '2026-07-21',
      premortem: '范围太大做不完', alternatives: ['先做插件', '不做'],
    })
    expect(r.open[0].premortem).toBe('范围太大做不完')
    expect(r.open[0].alternatives).toEqual(['先做插件', '不做'])
  })
  it('verdict moves decision out of open into archived + verdict event with frozen score', () => {
    const r = verdict([base], '2026-07-21-01', { outcome: 'hit', stillEndorse: true, resolved: '2026-08-04', evidence: [] })
    expect(r.open).toHaveLength(0)
    expect(r.archived).toMatchObject({ id: '2026-07-21-01', status: 'closed', outcome: 'hit', 'still-endorse': true })
    expect(r.event).toMatchObject({ event: 'verdict', outcome: 'hit', still_endorse: true })
    expect(r.event.score).toBeGreaterThan(10) // hit at 0.75 beats participation floor
  })
  it('verdict records weakest element when endorse=false, and preserves premortem', () => {
    const withPm = { ...base, premortem: '预设错了' }
    const r = verdict([withPm], '2026-07-21-01', {
      outcome: 'miss', stillEndorse: false, resolved: '2026-08-04', weakestElement: 'alternatives',
    })
    expect(r.archived['weakest-element']).toBe('alternatives')
    expect(r.archived.premortem).toBe('预设错了')
    expect(r.event.weakest_element).toBe('alternatives')
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

  describe('skip (v1.1 reasons)', () => {
    it('not-yet bumps check-date +14d, no strike, one skip event', () => {
      const r = skip([base], '2026-07-21-01', 'not-yet', '2026-08-05')
      expect(r.open[0]['check-date']).toBe('2026-08-19')
      expect(r.open[0].strikes).toBe(0)
      expect(r.archived).toBeUndefined()
      expect(r.events).toEqual([{ ts: '2026-08-05', event: 'skip', id: '2026-07-21-01', reason: 'not-yet' }])
    })
    it('irrelevant drops to archive, no strike', () => {
      const r = skip([base], '2026-07-21-01', 'irrelevant', '2026-08-05')
      expect(r.open).toHaveLength(0)
      expect(r.archived).toMatchObject({ status: 'dropped' })
      expect(r.events.map((e) => e.event)).toEqual(['skip'])
    })
    it('avoid counts a strike; third avoid downgrades with both events', () => {
      const r1 = skip([base], '2026-07-21-01', 'avoid', '2026-08-05')
      expect(r1.open[0].strikes).toBe(1)
      expect(r1.events.map((e) => e.event)).toEqual(['skip'])
      const two = { ...base, strikes: 2 }
      const r3 = skip([two], '2026-07-21-01', 'avoid', '2026-08-05')
      expect(r3.open).toHaveLength(0)
      expect(r3.archived).toMatchObject({ status: 'downgraded' })
      expect(r3.events.map((e) => e.event)).toEqual(['skip', 'downgrade'])
    })
  })
})
