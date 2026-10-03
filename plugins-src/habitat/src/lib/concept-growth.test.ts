import { describe, expect, it } from 'vitest'
import { deriveConceptGrowth } from './concept-growth'
import { fixture, difference } from './test-fixture'
import type { Snapshot } from './types'

function recorded(days: number[], groups = days.length): Snapshot {
  const s = fixture()
  s.meta.focus = { asOf: '2026-10-02', windowDays: 30, utcOffsetMinutes: 480 }
  s.nodes = [{ id: 'concept', key: 'concept', label: '测试概念', nodeType: 'keyword', status: 'observed', evidence: [] }]
  s.sources = []; s.evidence = []; s.attentionObservations = []; s.memberships = []; s.edges = []
  days.forEach((offset, i) => {
    const date = new Date(Date.UTC(2026, 8, 3 + offset)).toISOString().slice(0, 10)
    s.sources.push({ id: `s${i}`, path: `record-${i}.md`, hash: `hash${i}`, role: 'document', status: 'available', family: `family${i % groups}`, familyStatus: 'unresolved' })
    s.evidence.push({ id: `e${i}`, source: `s${i}`, locator: { start: 1, end: 1 }, role: 'attention', authorship: 'human', granularity: 'attention_sentence', verification: 'matched' })
    s.nodes[0].evidence!.push(`e${i}`)
    s.attentionObservations!.push({ evidence: `e${i}`, date, eventId: `event${i}`, signal: 'agent_user', dateBasis: 'same_day_session', confidence: .9 })
  })
  return s
}
const profile = (s: Snapshot) => deriveConceptGrowth(s).get('concept')!

describe('deterministic concept growth', () => {
  it('grows from recorded breadth and sustained days, without requiring a project name', () => {
    expect(profile(recorded([])).stage).toBe('hut')
    expect(profile(recorded([0])).stage).toBe('cottage')
    expect(profile(recorded([0, 1, 2])).stage).toBe('house')
    expect(profile(recorded([0, 4, 8])).stage).toBe('workshop')
    expect(profile(recorded([0, 2, 4, 6, 8, 10, 12, 14])).stage).toBe('midrise')
    expect(profile(recorded(Array.from({ length: 16 }, (_, i) => i * 29 / 15))).stage).toBe('tower')
  })
  it('does not turn same-day repetitions or one family copied many times into a skyline', () => {
    const sameDay = profile(recorded(Array(300).fill(29)))
    expect(sameDay.stage).toBe('house'); expect(sameDay.support.activeDays).toBe(1); expect(sameDay.support.spanDays).toBe(0)
    const copies = recorded(Array.from({ length: 20 }, (_, i) => i), 1)
    copies.attentionObservations!.forEach(o => { o.eventId = 'one-event'; o.date = '2026-09-03' })
    expect(profile(copies).stage).toBe('cottage'); expect(profile(copies).support.events).toBe(1)
    const redated = recorded(Array.from({ length: 20 }, (_, i) => i)); redated.attentionObservations!.forEach(o => { o.eventId = 'same-event' })
    expect(profile(redated).support.activeDays).toBe(1); expect(profile(redated).support.spanDays).toBe(0)
  })
  it('does not promote imported or metadata-only evidence into investment', () => {
    const s = recorded(Array.from({ length: 25 }, (_, i) => i))
    s.evidence.forEach(e => { e.verification = 'imported' })
    expect(profile(s).stage).toBe('hut'); expect(profile(s).support.activeDays).toBe(0)
    s.evidence.forEach(e => { e.verification = 'matched'; e.role = 'metadata' })
    expect(profile(s).stage).toBe('hut')
  })
  it('does not trust legacy default-human metadata as proof of active authorship', () => {
    const s = recorded(Array.from({ length: 25 }, (_, i) => i))
    s.evidence.forEach(e => { e.role = 'context'; e.granularity = 'paragraph' })
    expect(profile(s).stage).toBe('cottage'); expect(profile(s).support.activeDays).toBe(0)
    expect(profile(s).state).toBe('unassessed')
  })
  it('uses an explicit project declaration as one route, not imported mentions or task references', () => {
    const s = recorded([0, 3, 6, 9, 12, 15, 0, 3, 6, 9, 12, 15])
    expect(profile(s).stage).toBe('midrise')
    s.nodes[0].intentStatus = 'imported_project_mention'; expect(profile(s).stage).toBe('midrise')
    s.nodes[0].intentStatus = 'task_project_reference'; expect(profile(s).stage).toBe('midrise')
    s.nodes[0].intentStatus = 'declared_project'; expect(profile(s).stage).toBe('tower')
  })
  it('uses only frozen valid dates and never the wall clock or attention score', () => {
    const s = recorded([29]); expect(profile(s).state).toBe('growth')
    s.meta.focus!.asOf = '2026-11-02'; expect(profile(s).state).toBe('dormant')
    s.attentionObservations![0].date = '2026-11-03'; expect(profile(s).support.activeDays).toBe(0)
    s.attentionObservations![0].date = '2026-02-30'; expect(profile(s).support.activeDays).toBe(0)
    s.attention = [{ node: 'concept', score: 1, activeDays: 999, events: 999, lastObservedAt: '2026-11-02', evidence: [], category: 'concept' }]
    expect(profile(s).stage).toBe('cottage'); expect(profile(s).support.activeDays).toBe(0)
  })
  it('keeps the complete-snapshot base independent of foreground ordering and missing attention', () => {
    const s = recorded([0, 5, 10]); const before = profile(s)
    s.sources.reverse(); s.evidence.reverse(); s.nodes[0].evidence!.reverse(); s.attentionObservations!.reverse(); s.attention = []
    expect(profile(s)).toEqual(before)
  })
  it('does not claim construction for a candidate lineage, label edit or algorithm change', () => {
    const old = recorded([29]), current = structuredClone(old)
    old.meta.snapshotId = 'old'; current.meta.snapshotId = 'current'
    current.lineage = [{ id: 'l', change: 'regrouped', from: ['former'], to: ['concept'], status: 'candidate' }]
    const diff = { ...difference, changed: [current.nodes[0]] }
    expect(deriveConceptGrowth(current, { previous: old, diff }).get('concept')!.state).toBe('growth')
    current.lineage[0].status = 'confirmed'
    expect(deriveConceptGrowth(current, { previous: old, diff }).get('concept')!.state).toBe('rebuilding')
    current.meta.algorithm.version = 'different'
    expect(deriveConceptGrowth(current, { previous: old, diff }).get('concept')!.state).toBe('growth')
  })
  it('requires an actual per-node membership migration in a comparable diff', () => {
    const old = recorded([29]), current = structuredClone(old)
    old.meta.snapshotId = 'old'; current.meta.snapshotId = 'current'
    old.memberships = [{ id: 'm', node: 'concept', topic: 'before', role: 'primary', score: 1 }]
    current.memberships = [{ id: 'm', node: 'concept', topic: 'after', role: 'primary', score: 1 }]
    expect(deriveConceptGrowth(current, { previous: old, diff: difference }).get('concept')!.state).toBe('rebuilding')
    expect(deriveConceptGrowth(current).get('concept')!.state).toBe('growth')
  })
  it('does not turn topic aggregates into concept buildings', () => {
    const s = recorded([29]); s.nodes[0].nodeType = 'topic'; expect(deriveConceptGrowth(s).size).toBe(0)
  })
})

it('keeps stage and evidence support fixed for a snapshot when a comparison is selected', () => {
  const previous = recorded(Array.from({ length: 16 }, (_, i) => i * 29 / 15)), current = recorded([29])
  const alone = profile(current), compared = deriveConceptGrowth(current, { previous }).get('concept')!
  expect(compared.stage).toBe(alone.stage); expect(compared.support).toEqual(alone.support)
})
