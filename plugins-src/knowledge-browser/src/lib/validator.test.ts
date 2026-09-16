import { describe, expect, it } from 'vitest'
import fixture from '../../fixtures/minimal-valid.json'
import broken from '../../fixtures/invalid-broken-reference.json'
import { validateKnowledgeDataset } from './validator'

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

describe('validateKnowledgeDataset', () => {
  it('matches the fixed v3.1 fixture and registry', () => {
    expect(validateKnowledgeDataset(fixture).diagnostics).toEqual([])
  })
  it('keeps paired v3.0 datasets readable as a legacy format', () => {
    expect(validateKnowledgeDataset(legacyFixture()).diagnostics).toEqual([])
  })
  it('requires selection for v3.1 at dataset level', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    delete invalid.selection
    const result = validateKnowledgeDataset(invalid)
    expect(result.fatal).toBe(true)
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'schema.required', pointer: '/selection' })]))
  })
  it('isolates v3.1 records without epistemic assessment', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    delete invalid.entities[0].epistemic
    const result = validateKnowledgeDataset(invalid)
    expect(result.fatal).toBe(false)
    expect(result.isolatedIds.has('e1')).toBe(true)
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'schema.required', pointer: '/entities/0/epistemic' })]))
  })
  it('enforces the strong-only epistemic policy', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    invalid.entities[0].epistemic = { strength: 'medium', basis: ['agent_inference'] }
    const codes = validateKnowledgeDataset(invalid).diagnostics.map(item => item.code)
    expect(codes).toContain('business.epistemic-strength')
    expect(codes).toContain('business.epistemic-basis')
  })
  it('isolates a broken record without treating it as a verified empty dataset', () => {
    const result = validateKnowledgeDataset(broken)
    expect(result.fatal).toBe(false)
    expect(result.isolatedIds.has('q1')).toBe(true)
    expect(result.diagnostics.some(item => item.code === 'business.broken-ref')).toBe(true)
  })
  it('enforces P3 rationale and evidence independence', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    invalid.relations[0] = { ...invalid.relations[0], p: 3, type: 'tradeoff_with' } as typeof invalid.relations[number]
    const codes = validateKnowledgeDataset(invalid).diagnostics.map(item => item.code)
    expect(codes).toContain('business.p3-reason')
    expect(codes).toContain('business.p3-independence')
  })
})
