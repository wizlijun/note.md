import { describe, expect, it } from 'vitest'
import fixture from '../../fixtures/minimal-valid.json'
import { buildIndexes } from './indexes'
import { buildKnowledgeGraph } from './graph-model'
import type { KnowledgeDataset } from './types'

const dataset = fixture as unknown as KnowledgeDataset

describe('knowledge graph projection', () => {
  it('projects every knowledge kind and preserves relation types and participant roles', () => {
    const graph = buildKnowledgeGraph(dataset, buildIndexes(dataset), { scope: 'all' })

    expect(new Set(graph.nodes.map(node => node.kind))).toEqual(new Set([
      'entities', 'concepts', 'claims', 'events', 'narratives', 'relations',
    ]))
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'r1', target: 'e1', label: 'delegator', relationType: 'delegates_to', layer: 'relation' }),
      expect.objectContaining({ source: 'r1', target: 'e2', label: 'delegate', relationType: 'delegates_to', layer: 'relation' }),
      expect.objectContaining({ source: 'r1', target: 'v1', label: 'work', relationType: 'delegates_to', layer: 'relation' }),
      expect.objectContaining({ source: 'r2', target: 'v1', label: 'action', relationType: 'requires_approval', layer: 'relation' }),
      expect.objectContaining({ source: 'q1', target: 'c1', label: 'about', relationType: 'about', layer: 'reference' }),
      expect.objectContaining({ source: 'n1', target: 'r1', label: 'premise', relationType: 'narrative_member', layer: 'reference' }),
    ]))
    expect(graph.relationTypes).toEqual(['delegates_to', 'requires_approval'])
    expect(graph.truncated).toEqual({ nodes: 0, edges: 0 })
  })

  it('keeps a focused record and its two-hop relationship context', () => {
    const graph = buildKnowledgeGraph(dataset, buildIndexes(dataset), { scope: 'focus', centerId: 'e2' })

    expect(graph.nodes[0].id).toBe('e2')
    expect(graph.nodes.map(node => node.id)).toEqual(expect.arrayContaining(['r1', 'e1', 'v1']))
    expect(graph.edges.some(edge => edge.source === 'r1' && edge.target === 'e1')).toBe(true)
    expect(graph.edges.some(edge => edge.source === 'r1' && edge.target === 'v1')).toBe(true)
    expect(graph.truncated).toEqual({ nodes: 0, edges: 0 })
  })

  it('deduplicates repeated role edges and reports deterministic node and edge limits', () => {
    const repeated = structuredClone(dataset)
    repeated.relations[0].args.delegate = ['e2', 'e2']
    const indexes = buildIndexes(repeated)
    const full = buildKnowledgeGraph(repeated, indexes, { scope: 'all' })
    const first = buildKnowledgeGraph(repeated, indexes, { scope: 'all', centerId: 'e1', maxNodes: 7, maxEdges: 4 })
    const second = buildKnowledgeGraph(repeated, indexes, { scope: 'all', centerId: 'e1', maxNodes: 7, maxEdges: 4 })

    expect(first).toEqual(second)
    expect(first.nodes).toHaveLength(7)
    expect(first.edges.length).toBeLessThanOrEqual(4)
    expect(first.truncated.nodes).toBeGreaterThan(0)
    expect(first.truncated.edges).toBeGreaterThan(0)
    expect(full.edges.filter(edge => edge.source === 'r1' && edge.target === 'e2' && edge.label === 'delegate')).toHaveLength(1)
  })

  it('keeps all node kinds and representative explicit relation types when a large graph is capped', () => {
    const large = structuredClone(dataset)
    for (let index = 2; index <= 102; index++) large.claims.push({
      ...structuredClone(large.claims[0]), id: `q${index}`, text: `Synthetic claim ${index}`,
    } as typeof large.claims[number])

    const graph = buildKnowledgeGraph(large, buildIndexes(large), { scope: 'all', centerId: 'e1', maxNodes: 80, maxEdges: 120 })
    expect(graph.nodes).toHaveLength(80)
    expect(new Set(graph.nodes.map(node => node.kind))).toEqual(new Set([
      'entities', 'concepts', 'claims', 'events', 'narratives', 'relations',
    ]))
    expect(graph.relationTypes).toEqual(['delegates_to', 'requires_approval'])
    expect(graph.edges.some(edge => edge.layer === 'relation' && edge.source === 'r1')).toBe(true)
    expect(graph.edges.some(edge => edge.layer === 'relation' && edge.source === 'r2')).toBe(true)
  })

  it('keeps a visible edge for relation types that occur after the edge budget', () => {
    const crowded = structuredClone(dataset)
    const flood = Array.from({ length: 45 }, (_, index) => ({
      ...structuredClone(crowded.relations[0]), id: `r${index + 3}`, type: 'participates_in',
    } as typeof crowded.relations[number]))
    crowded.relations = [...flood, ...crowded.relations]

    const indexes = buildIndexes(crowded)
    const full = buildKnowledgeGraph(crowded, indexes, { scope: 'all', centerId: 'e1', maxNodes: 200, maxEdges: 500 })
    const graph = buildKnowledgeGraph(crowded, indexes, { scope: 'all', centerId: 'e1', maxNodes: 80, maxEdges: 120 })
    expect(graph.edges).toHaveLength(120)
    expect(graph.relationTypes).toEqual(['participates_in', 'delegates_to', 'requires_approval'])
    for (const type of graph.relationTypes) {
      const edge = graph.edges.find(item => item.layer === 'relation' && item.relationType === type)
      expect(edge).toBeDefined()
      expect(graph.nodes.some(node => node.id === edge!.source)).toBe(true)
      expect(graph.nodes.some(node => node.id === edge!.target)).toBe(true)
    }
    for (const relation of graph.nodes.filter(node => node.kind === 'relations')) {
      expect(graph.edges.filter(edge => edge.layer === 'relation' && edge.relationId === relation.id)).toHaveLength(
        full.edges.filter(edge => edge.layer === 'relation' && edge.relationId === relation.id).length,
      )
    }
  })

  it('omits an oversized N-ary relation instead of showing a partial role set', () => {
    const oversized = structuredClone(dataset)
    oversized.relations[0].args = Object.fromEntries(
      Array.from({ length: 121 }, (_, index) => [`role_${index + 1}`, 'e1']),
    )

    const graph = buildKnowledgeGraph(oversized, buildIndexes(oversized), {
      scope: 'all', centerId: 'e1', maxNodes: 80, maxEdges: 120,
    })

    expect(graph.nodes.some(node => node.id === 'r1')).toBe(false)
    expect(graph.edges.some(edge => edge.relationId === 'r1')).toBe(false)
    expect(graph.edges.filter(edge => edge.relationId === 'r2' && edge.layer === 'relation')).toHaveLength(2)
    expect(graph.truncated.nodes).toBeGreaterThan(0)
    expect(graph.truncated.edges).toBeGreaterThanOrEqual(121)
  })

  it('omits a relation with a source participant instead of dropping that role', () => {
    const withSourceParticipant = structuredClone(dataset)
    withSourceParticipant.relations[0].args.source = 's1'

    const graph = buildKnowledgeGraph(withSourceParticipant, buildIndexes(withSourceParticipant), {
      scope: 'all', centerId: 'e1', maxNodes: 80, maxEdges: 120,
    })

    expect(graph.nodes.some(node => node.id === 'r1')).toBe(false)
    expect(graph.edges.some(edge => edge.relationId === 'r1')).toBe(false)
    expect(graph.edges.filter(edge => edge.relationId === 'r2' && edge.layer === 'relation')).toHaveLength(2)
  })

  it('omits isolated records and dangling references without inventing graph nodes', () => {
    const indexes = buildIndexes(dataset, new Set(['c1']))
    const graph = buildKnowledgeGraph(dataset, indexes, { scope: 'all' })

    expect(graph.nodes.some(node => node.id === 'c1')).toBe(false)
    expect(graph.edges.some(edge => edge.source === 'c1' || edge.target === 'c1')).toBe(false)
  })
})
