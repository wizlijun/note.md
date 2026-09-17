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
  it('keeps extractor rule 3.1.0 readable with a compatibility warning', () => {
    const compatible = structuredClone(fixture) as Record<string, any>
    compatible.generated.rule = 'relation-schema-extractor/3.1.0'
    const result = validateKnowledgeDataset(compatible)
    expect(result.valid).toBe(true)
    expect(result.isolatedIds.size).toBe(0)
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'version.rule-compatible', severity: 'warning' })])
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
  it('requires explicit speech-act evidence for decisions and speech-act relations', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    invalid.claims[0].kind = 'decision'
    invalid.claims[0].epistemic.basis = ['explicit_statement']
    invalid.relations[0].epistemic.basis = ['explicit_statement']
    const result = validateKnowledgeDataset(invalid)
    expect(result.diagnostics.filter(item => item.code === 'business.speech-act')).toHaveLength(2)
    expect(result.isolatedIds).toEqual(new Set(['q1', 'r1']))
  })
  it('checks claim attribution against evidence speakers', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    invalid.claims[0].by = ['e2']
    const result = validateKnowledgeDataset(invalid)
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'business.claim-speaker', objectId: 'q1' })]))
  })
  it('rejects direct observation as proof of speaker-attributed content', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    invalid.claims[0].epistemic.basis = ['direct_observation']
    expect(validateKnowledgeDataset(invalid).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'business.speaker-observation' })]))
  })
  it('rejects false independent corroboration from the same source group', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    invalid.sources[0].group = 'same-import'
    invalid.sources.push({ id: 's2', uri: '/fixtures/derived.json', v: null, origin: 'derived', group: 'same-import' })
    invalid.evidence.push({ id: 'x3', s: 's2', loc: 'item-1', quote: '发布前须经工程负责人批准。', speaker: 'e1' })
    invalid.claims[0].ev = ['x1', 'x3']
    invalid.claims[0].epistemic.basis.push('independent_corroboration')
    expect(validateKnowledgeDataset(invalid).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'business.independent-corroboration' })]))
  })
  it('rejects invented decimal precision without local disclosure', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    invalid.claims[0].text = '工程负责人报告发布成本为 1.1 美元。'
    expect(validateKnowledgeDataset(invalid).diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'business.numeric-precision' })]))
  })
  it('warns when a high-risk record has no object-level limits', () => {
    const invalid = structuredClone(fixture) as Record<string, any>
    invalid.claims[0].kind = 'evaluation'
    invalid.claims[0].text = '工程负责人认为发布风险较低。'
    delete invalid.claims[0].limits
    const result = validateKnowledgeDataset(invalid)
    expect(result.valid).toBe(true)
    expect(result.isolatedIds.has('q1')).toBe(false)
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'warning.local-limits', severity: 'warning' })]))
  })
})
