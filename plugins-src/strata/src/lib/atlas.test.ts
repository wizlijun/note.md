import { describe, expect, it } from 'vitest'
import { ATLAS_VERSION, buildAtlas, meetingClusterNames } from './atlas'
import type { TerrainInputNode } from './types-terrain'

function meeting(id: string, terms: string[], source = id, extra: Partial<TerrainInputNode> = {}): TerrainInputNode {
  return { id, title: '发言人物', kind: 'claim', state: 'imported', features: [id], topicTerms: terms, topicSourceId: source,
    links: [], sourceGroups: [{ groupId: id, groupVersion: 'v1', priority: 1, dates: ['2026-09-30'] }], ...extra }
}

describe('meeting vocabulary hierarchy', () => {
  it('does not turn an explicitly unnamed person into a topic or a cross-meeting lexical edge', () => {
    const nodes = [meeting('person-a', [], 'meeting-a', { features: [], kind: 'entity' }), meeting('person-b', [], 'meeting-b', { features: [], kind: 'entity' })]
    const atlas = buildAtlas(nodes, 'meeting-vocabulary')
    expect(atlas.diagnostics.graphEdges).toBe(0)
    expect(atlas.nodes).toHaveLength(2)
    expect(atlas.domains).toHaveLength(2)
    expect([...atlas.domains, ...atlas.topics].every(cluster => cluster.name === '未命名知识群')).toBe(true)
    const index = buildAtlas(nodes.map(({ topicTerms: _terms, topicSourceId: _source, ...node }) => node), 'index')
    expect(index.diagnostics.graphEdges).toBe(1)
    expect(index.domains[0].name).toBe('发言人物')
  })

  it('prefers an actual concept over a more frequently referenced product entity', () => {
    const nodes = [meeting('concept', ['有界上下文'], 'meeting', { kind: 'concept', features: ['有界上下文'] }),
      ...Array.from({ length: 12 }, (_, i) => meeting(`product-${i}`, ['常用产品'], 'meeting', { kind: 'entity', links: ['concept'] }))]
    const atlas = buildAtlas(nodes, 'concept-first')
    const cluster = atlas.domains.find(group => group.memberIds.includes('concept'))!
    expect(cluster.memberIds.length).toBeGreaterThan(8)
    expect(cluster.name).toBe('有界上下文')
  })

  it('downweights globally common vocabulary without inventing a category label', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => meeting(`node-${i}`, i < 2 ? ['通用协作', '证据追溯'] : ['通用协作'], `meeting-${i}`,
      { kind: 'concept', links: i === 1 ? ['node-0'] : [] }))
    const atlas = buildAtlas(nodes, 'specific-terms')
    const cluster = atlas.domains.find(group => group.memberIds.includes('node-0'))!
    expect(cluster.memberIds).toEqual(['node-0', 'node-1'])
    expect(cluster.name).toBe('证据追溯')
    const originals = new Set(nodes.flatMap(node => node.topicTerms!))
    for (const group of [...atlas.domains, ...atlas.topics]) for (const term of group.name.split(' · ')) expect(originals.has(term)).toBe(true)
  })

  it('balances independent meeting support when member coverage and global prevalence are equal', () => {
    const repeated = Array.from({ length: 12 }, (_, i) => meeting(`repeat-${i}`, ['单会用词'], 'one-meeting', { kind: 'concept' }))
    const shared = Array.from({ length: 12 }, (_, i) => meeting(`cross-${i}`, ['跨会共同概念'], `cross-meeting-${i % 4}`, { kind: 'concept' }))
    const background = Array.from({ length: 20 }, (_, i) => meeting(`other-${i}`, [i < 3 ? '单会用词' : `其他原词${i}`], `other-meeting-${i}`, { kind: 'concept' }))
    const names = meetingClusterNames([...repeated, ...shared, ...background], [{ id: 'cluster', memberIds: [...repeated, ...shared].map(node => node.id) }])
    expect(names.get('cluster')).toBe('跨会共同概念')
  })

  it('does not let three rare references outrank a concept supported by a hundred members', () => {
    const majority = Array.from({ length: 100 }, (_, i) => meeting(`major-${i}`, ['主概念'], 'main-meeting', { kind: 'concept' }))
    const rare = Array.from({ length: 3 }, (_, i) => meeting(`rare-${i}`, ['跨会稀有词'], `rare-meeting-${i}`, { kind: 'concept' }))
    const nodes = [...majority, ...rare]
    const names = meetingClusterNames(nodes, [{ id: 'cluster', memberIds: nodes.map(node => node.id) }])
    expect(names.get('cluster')).toBe('主概念')
  })

  it('names the current date cohort without leaking unsupported historical concepts or altering geometry', () => {
    const historical = meeting('old', ['历史概念'], 'old-meeting', { kind: 'concept' })
    const current = meeting('new', ['当前概念'], 'new-meeting', { kind: 'concept', links: ['old'] })
    const atlas = buildAtlas([historical, current], 'stable-history'), before = JSON.stringify(atlas)
    const names = meetingClusterNames([current], [...atlas.domains, ...atlas.topics])
    expect([...names.values()].every(name => name === '当前概念')).toBe(true)
    expect(names.size).toBe(2)
    expect(meetingClusterNames([], [...atlas.domains, ...atlas.topics]).size).toBe(0)
    const unknown = { ...current, topicTerms: [] }
    expect([...meetingClusterNames([unknown], atlas.domains).values()]).toEqual(['未命名知识群'])
    expect(JSON.stringify(atlas)).toBe(before)
  })

  it('keeps semantic links effective when lexical terms are intentionally empty', () => {
    const nodes = [meeting('person', [], 'meeting', { features: [], links: ['concept'] }),
      meeting('concept', ['来源可追溯性'], 'meeting', { kind: 'concept', features: ['来源可追溯性'] })]
    const atlas = buildAtlas(nodes, 'semantic-links')
    expect(atlas.diagnostics.graphEdges).toBe(1)
    expect(atlas.nodes[0].parentDomain).toBe(atlas.nodes[1].parentDomain)
    expect(atlas.domains[0].name).toBe('来源可追溯性')
  })

  it('rehydrates vocabulary from fresh input without moving restored geometry or changing index atlas version', () => {
    const nodes = [meeting('a', ['旧概念'], 'meeting-a', { kind: 'concept' }), meeting('b', [], 'meeting-b', { features: [] })]
    const old = buildAtlas(nodes, 'meeting-vocabulary-v1')
    const geometryOnly = { ...old, nodes: old.nodes.map(({ id, x, y, radius, parentTopic, parentDomain, crowded }) => ({ id, x, y, radius, parentTopic, parentDomain, crowded })) } as typeof old
    const input = [{ ...nodes[0], topicTerms: ['新概念原词'] }, nodes[1]]
    const fresh = buildAtlas(input, old.epoch, geometryOnly)
    expect(fresh.version).toBe(ATLAS_VERSION)
    expect(fresh.version).toBe('strata-atlas/2')
    expect(fresh.nodes.map(node => [node.id, node.x, node.y, node.parentTopic])).toEqual(old.nodes.map(node => [node.id, node.x, node.y, node.parentTopic]))
    expect(fresh.nodes[0].topicTerms).toEqual(['新概念原词'])
    expect(fresh.nodes[0].topicSourceId).toBe('meeting-a')
    expect(fresh.domains.find(cluster => cluster.memberIds.includes('a'))!.name).toBe('新概念原词')
    expect(fresh.domains.find(cluster => cluster.memberIds.includes('b'))!.name).toBe('未命名知识群')
    expect(buildAtlas([...input].reverse(), 'rebuild').nodes).toEqual(buildAtlas(input, 'rebuild').nodes)
  })
})
