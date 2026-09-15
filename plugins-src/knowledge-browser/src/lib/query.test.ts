import { describe, expect, it } from 'vitest'
import fixture from '../../fixtures/minimal-valid.json'
import { parseKnowledgeDataset } from './parser'
import { queryRecords, tokenizeQuery } from './query'

describe('queryRecords', () => {
  it('uses NFKC, quoted phrases and AND matching', async () => {
    const parsed = await parseKnowledgeDataset(JSON.stringify(fixture), 'research/test.knowledge.json')
    expect(tokenizeQuery('"正式发布" 负责人')).toEqual(['正式发布', '负责人'])
    const hits = queryRecords(parsed.records, { query: '"正式发布" 负责人', indexes: parsed.indexes })
    expect(hits.some(hit => hit.record.id === 'q1')).toBe(true)
  })
  it('keeps filtering dimensions independent', async () => {
    const parsed = await parseKnowledgeDataset(JSON.stringify(fixture), 'test.json')
    expect(queryRecords(parsed.records, { kinds: new Set(['relations']), priorities: new Set([0]) })).toHaveLength(2)
  })
  it('locates local and dataset-scoped IDs exactly', async () => {
    const parsed = await parseKnowledgeDataset(JSON.stringify(fixture), 'test.json')
    expect(queryRecords(parsed.records, { query: 'q1' })[0].record.id).toBe('q1')
    expect(queryRecords(parsed.records, { query: `${fixture.id}#q1`, datasetId: fixture.id })[0].record.id).toBe('q1')
    expect(queryRecords(parsed.records, { query: 'ks_00000000-0000-4000-8000-000000000000#q1', datasetId: fixture.id })).toEqual([])
  })
})
