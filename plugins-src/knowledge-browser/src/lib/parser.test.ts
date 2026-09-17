import { describe, expect, it } from 'vitest'
import fixture from '../../fixtures/minimal-valid.json'
import { parseKnowledgeDataset } from './parser'

function legacyFixture(): Record<string, any> {
  const legacy = structuredClone(fixture) as Record<string, any>
  legacy.schema = 'knowledge-representation-dataset/3.0.0'
  legacy.generated.rule = 'relation-schema-extractor/3.0.0'
  delete legacy.selection
  for (const kind of ['entities', 'concepts', 'claims', 'events', 'narratives', 'relations']) {
    for (const record of legacy[kind]) delete record.epistemic
  }
  return legacy
}

describe('parseKnowledgeDataset', () => {
  it('returns an immutable-source browsing model for valid v3.1 data', async () => {
    const source = JSON.stringify(fixture)
    const result = await parseKnowledgeDataset(source, 'research/test.knowledge.json')
    expect(result.status).toBe('ready')
    expect(result.records).toHaveLength(8)
    expect(result.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.sourceText).toBe(source)
  })
  it('opens paired v3.0 data as a legacy read-only format', async () => {
    const result = await parseKnowledgeDataset(JSON.stringify(legacyFixture()), 'research/legacy.knowledge.json')
    expect(result.status).toBe('ready')
    expect(result.records).toHaveLength(8)
  })
  it('opens extractor rule 3.1.0 with a non-blocking compatibility warning', async () => {
    const compatible = structuredClone(fixture) as Record<string, any>
    compatible.generated.rule = 'relation-schema-extractor/3.1.0'
    const result = await parseKnowledgeDataset(JSON.stringify(compatible), 'research/compatible.knowledge.json')
    expect(result.status).toBe('ready')
    expect(result.records).toHaveLength(8)
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'version.rule-compatible', severity: 'warning' })])
  })
  it.each([
    ['knowledge-representation-dataset/3.1.0', 'relation-schema-extractor/3.0.0'],
    ['knowledge-representation-dataset/3.0.0', 'relation-schema-extractor/3.1.0'],
  ])('rejects cross-paired schema %s and rule %s', async (schema, rule) => {
    const invalid = legacyFixture()
    invalid.schema = schema
    invalid.generated.rule = rule
    if (schema.endsWith('/3.1.0')) invalid.selection = fixture.selection
    const result = await parseKnowledgeDataset(JSON.stringify(invalid), 'test.json')
    expect(result.status).toBe('unsupported')
  })
  it('does not interpret an unknown schema', async () => {
    const result = await parseKnowledgeDataset(JSON.stringify({ ...fixture, schema: 'knowledge-representation-dataset/4.0.0' }), 'test.json')
    expect(result.status).toBe('unsupported')
    expect(result.records).toEqual([])
  })
})
