import { expect, it } from 'vitest'
import { cityNodes, filterNodes, focusDistrictLabel, edgeLabel, relationExplanation, signalLabel, dateBasisLabel, isExplicit, locatorLabel, nodeFamilyCounts } from './domain'
import { fixture, focusFixture } from './test-fixture'

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

it('keeps only keywords in the new graph and uses primary memberships for district browsing', () => {
  const snapshot = fixture()
  snapshot.meta.algorithm.version = 'habitat-keyword/2'
  snapshot.nodes[0].nodeType = snapshot.nodes[1].nodeType = 'keyword'
  snapshot.nodes.push({ id: 'doc', key: 'doc', nodeType: 'document', label: '材料文件', status: 'observed' })
  snapshot.memberships = [
    { id: 'm1', node: 'n1', topic: 't1', role: 'primary', score: 1 },
    { id: 'm2', node: 'n2', topic: 't1', role: 'secondary', score: .2 }
  ]
  expect(filterNodes(snapshot, '', '').map(n => n.id)).toEqual(['n1', 'n2'])
  expect(filterNodes(snapshot, '', 't1').map(n => n.id)).toEqual(['n1'])
  expect(filterNodes(snapshot, 'paperboat', '').map(n => n.id)).toEqual(['n1'])
  expect(isExplicit({ ...snapshot.edges[0], edgeType: 'co_occurs', status: 'statistical' })).toBe(false)
})

it('keeps unconnected-keyword browsing distinct from semantic communities', () => {
  const snapshot = fixture()
  snapshot.meta.algorithm.version = 'habitat-keyword/2'
  snapshot.nodes[0].nodeType = snapshot.nodes[1].nodeType = 'keyword'
  snapshot.memberships = [{ id: 'm1', node: 'n1', topic: 't1', role: 'primary', score: 1 }]
  expect(filterNodes(snapshot, '', '__unassigned__').map(n => n.id)).toEqual(['n2'])
  expect(filterNodes(snapshot, '', 't1').map(n => n.id)).toEqual(['n1'])
})

it('filters and orders the attention view without changing full-history keywords', () => {
  const snapshot = focusFixture()
  expect(filterNodes(snapshot, '', '', true).map(n => n.id)).toEqual(['n2', 'n1'])
  expect(filterNodes(snapshot, '', '').map(n => n.id)).toEqual(['n1', 'n2', 'old'])
  expect(filterNodes(snapshot, 'paperboat', '', true).map(n => n.id)).toEqual(['n1'])
  snapshot.attention = []
  expect(filterNodes(snapshot, '', '', true)).toEqual([])
  expect(filterNodes(fixture(), '', '', true)).toEqual(filterNodes(fixture(), '', ''))
})

it('uses visible foreground concepts for district captions while retaining historical names outside focus', () => {
  const snapshot = focusFixture()
  const attention = new Map(snapshot.attention!.map(item => [item.node, item]))
  expect(focusDistrictLabel(snapshot.nodes, attention)?.name).toBe('观察与反馈 · 纸船计划')
  expect(focusDistrictLabel(snapshot.nodes.filter(node => node.id === 'n1'), attention)?.category).toBe('context')
  expect(focusDistrictLabel(snapshot.nodes, new Map())).toBeUndefined()
  expect(focusDistrictLabel(snapshot.nodes, attention)?.name).not.toContain('研究方法')
})

it('distinguishes repeated discussion events from source-group co-occurrence and translates attribution signals', () => {
  const edge = { ...fixture().edges[0], edgeType: 'co_discussed', status: 'statistical' }
  expect(edgeLabel(edge.edgeType)).toBe('重复共同讨论')
  expect(relationExplanation(edge)).toContain('至少两次去重的主动记录事件')
  expect(relationExplanation(edge)).not.toContain('至少两个去重来源组')
  expect(relationExplanation({ ...edge, edgeType: 'co_occurs' })).toContain('至少两个去重来源组')
  expect(isExplicit(edge)).toBe(false)
  expect(signalLabel('submitted_material')).toBe('提交的材料')
  expect(signalLabel('trace_request')).toBe('留存过程的请求')
  expect(dateBasisLabel('daily_date')).toBe('日记所属日期')
})
