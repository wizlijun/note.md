import { describe, expect, it } from 'vitest'
import fixture from '../../fixtures/minimal-valid.json'
import { parseKnowledgeDataset } from './parser'

describe('parseKnowledgeDataset', () => {
  it('returns an immutable-source browsing model for valid v3 data', async () => {
    const source = JSON.stringify(fixture)
    const result = await parseKnowledgeDataset(source, 'research/test.knowledge.json')
    expect(result.status).toBe('ready')
    expect(result.records).toHaveLength(8)
    expect(result.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.sourceText).toBe(source)
  })
  it('does not interpret an unknown schema', async () => {
    const result = await parseKnowledgeDataset(JSON.stringify({ ...fixture, schema: 'knowledge-representation-dataset/4.0.0' }), 'test.json')
    expect(result.status).toBe('unsupported')
    expect(result.records).toEqual([])
  })
})
