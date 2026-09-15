import { describe, expect, it } from 'vitest'
import fixture from '../../fixtures/minimal-valid.json'
import { buildIndexes } from './indexes'
import type { KnowledgeDataset } from './types'

describe('buildIndexes', () => {
  it('builds participant, evidence and incoming indexes without flattening relation roles', () => {
    const indexes = buildIndexes(fixture as unknown as KnowledgeDataset)
    expect(indexes.nodesById.size).toBe(8)
    expect(indexes.relationsByParticipant.get('e1')?.map(item => item.id)).toEqual(['r1', 'r2'])
    expect(indexes.recordsByEvidence.get('x1')?.length).toBe(7)
    expect(indexes.incomingReferences.get('v1')?.some(item => item.from === 'r1')).toBe(true)
  })
})
