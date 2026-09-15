import { describe, expect, it } from 'vitest'
import fixture from '../../fixtures/minimal-valid.json'
import broken from '../../fixtures/invalid-broken-reference.json'
import { validateKnowledgeDataset } from './validator'

describe('validateKnowledgeDataset', () => {
  it('matches the fixed v3 fixture and registry', () => {
    expect(validateKnowledgeDataset(fixture).diagnostics).toEqual([])
  })
  it('isolates a broken record without treating it as a verified empty dataset', () => {
    const result = validateKnowledgeDataset(broken)
    expect(result.fatal).toBe(false)
    expect(result.isolatedIds.has('q1')).toBe(true)
    expect(result.diagnostics.some(item => item.code === 'business.broken-ref')).toBe(true)
  })
  it('enforces P3 rationale and evidence independence', () => {
    const invalid = structuredClone(fixture)
    invalid.relations[0] = { ...invalid.relations[0], p: 3, type: 'tradeoff_with' } as typeof invalid.relations[number]
    const codes = validateKnowledgeDataset(invalid).diagnostics.map(item => item.code)
    expect(codes).toContain('business.p3-reason')
    expect(codes).toContain('business.p3-independence')
  })
})
