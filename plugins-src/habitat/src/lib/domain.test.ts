import { expect, it } from 'vitest'
import { cityNodes, filterNodes, isExplicit, locatorLabel, nodeFamilyCounts } from './domain'
import { fixture } from './test-fixture'

it('keeps secondary topic membership and aliases searchable', () => {
  const snapshot = fixture()
  expect(filterNodes(snapshot, 'paperboat', '').map(n => n.id)).toEqual(['n1'])
  expect(filterNodes(snapshot, '', 't1').map(n => n.id)).toEqual(['n2', 't1'])
})
it('bounds visual landmarks while retaining a selected low-support node', () => {
  const nodes = Array.from({ length: 2000 }, (_, i) => ({ ...fixture().nodes[1], id: `n${i}`, evidence: i < 100 ? ['e1'] : [] }))
  const result = cityNodes(nodes, 'n1999')
  expect(result).toHaveLength(72); expect(result[0].id).toBe('n1999'); expect(nodes).toHaveLength(2000)
  expect(cityNodes([...nodes].reverse(), 'n1999')).toEqual(result)
})
it('retains concepts and source sheds when many project candidates exist', () => {
  const sample = fixture().nodes[1]
  const nodes = ['project', 'topic', 'concept', 'entity', 'document'].flatMap(nodeType => Array.from({ length: 401 }, (_, i) => ({ ...sample, id: `${nodeType}-${i}`, nodeType })))
  const result = cityNodes(nodes, '')
  expect(result).toHaveLength(72)
  expect(new Set(result.map(n => n.nodeType))).toEqual(new Set(['project', 'topic', 'concept', 'entity', 'document']))
  expect(result.filter(n => n.nodeType === 'project')).toHaveLength(16)
})
it('does not render imported semantic claims or co-occurrence as explicit proof', () => {
  const edge = fixture().edges[0]
  expect(isExplicit(edge)).toBe(true)
  expect(isExplicit({ ...edge, edgeType: 'causes', status: 'imported' })).toBe(false)
  expect(isExplicit({ ...edge, edgeType: 'cites', status: 'imported' })).toBe(false)
  expect(isExplicit({ ...edge, edgeType: 'co_mentioned_in', status: 'candidate' })).toBe(false)
})
it('distinguishes source line and JSON object locators', () => {
  expect(locatorLabel({ start: 7, end: 11, outlineId: 'u' })).toBe('第 7–11 行 · 节点 u')
  expect(locatorLabel({ start: 0, end: 0, jsonPointer: '/entities/0' })).toBe('/entities/0')
})
it('caps repeated evidence in one known family and separates unknown lineage', () => {
  const snapshot = fixture()
  snapshot.nodes[0].evidence = ['e1', 'e2', 'e3']
  snapshot.sources.push({ ...snapshot.sources[0], id: 's2', family: 'unknown', familyStatus: 'unresolved' })
  snapshot.evidence.push({ ...snapshot.evidence[0], id: 'e3', source: 's2' })
  expect(nodeFamilyCounts(snapshot).get('n1')).toEqual({ verified: 1, provisional: 0, unresolved: 1 })
})
