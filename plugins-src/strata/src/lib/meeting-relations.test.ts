import { expect, it } from 'vitest'
import { meetingRelationGroups } from './meeting-relations'
import type { AtlasNode } from './types-terrain'

const nodes = new Map(Array.from({ length: 30 }, (_, i) => {
  const id = `n${i}`
  return [id, { id, parentDomain: `d${i % 5}`, parentTopic: `t${i % 10}` } as AtlasNode]
}))
const visible = new Set(nodes.keys()), shown = new Set(Array.from({ length: 5 }, (_, i) => `d${i}`))
const edge = (...ids: string[]) => ({ source: ids[0], target: ids[1], participants: ids.map((nodeId, i) => ({ nodeId, role: `role${i}` })) })

it('aggregates complete role sets at overview and preserves hyperedges instead of fabricating pairs', () => {
  expect(meetingRelationGroups([edge('n0', 'n1'), edge('n5', 'n6'), edge('n0', 'n5'), edge('n0', 'n1', 'n2')], nodes, visible, shown, 'domain')).toEqual([
    { ids: ['d0', 'd1'], count: 2 }, { ids: ['d0', 'd1', 'd2'], count: 1 },
  ])
})
it('does not draw partial relationships with hidden dates, missing participants or unlabelled groups', () => {
  expect(meetingRelationGroups([edge('n0', 'n1', 's1')], nodes, visible, shown, 'domain')).toEqual([])
  expect(meetingRelationGroups([edge('n0', 'n1')], nodes, new Set(['n0']), shown, 'domain')).toEqual([])
  expect(meetingRelationGroups([edge('n0', 'n1')], nodes, visible, new Set(['d0']), 'domain')).toEqual([])
})
it('shows only selected knowledge relationships in detail and bounds overview degree', () => {
  expect(meetingRelationGroups([edge('n0', 'n1'), edge('n2', 'n3')], nodes, visible, new Set(), 'knowledge', 'n0')).toEqual([{ ids: ['n0', 'n1'], count: 1 }])
  const groups = meetingRelationGroups([1, 2, 3, 4].map(i => edge('n0', `n${i}`)), nodes, visible, shown, 'domain')
  expect(groups).toHaveLength(3)
  expect(meetingRelationGroups([edge(...Array(33).fill('n0').map((_, i) => `x${i}`))], nodes, visible, shown, 'domain')).toEqual([])
})
