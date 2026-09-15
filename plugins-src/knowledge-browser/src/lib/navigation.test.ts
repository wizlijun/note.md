import { describe, expect, it } from 'vitest'
import {
  assessKnowledgeReference, createNavigation, keepSelectionForSnapshot, navigateBack,
  navigateTo, parseKnowledgeReference, serializeKnowledgeReference, visibleBreadcrumbs,
} from './navigation'

const dataset = 'ks_85cb6e32-b304-4e00-9331-b919b7c40b41'

describe('object navigation', () => {
  it('keeps a bounded dataset-scoped return trail and exposes only three breadcrumbs', () => {
    let state = createNavigation(dataset, 'q1')
    for (const ref of ['e1', 'r1', 'v1', 'n1']) state = navigateTo(state, { datasetId: dataset, ref })
    expect(visibleBreadcrumbs(state).visible.map(item => item.ref)).toEqual(['r1', 'v1', 'n1'])
    expect(visibleBreadcrumbs(state).hidden.map(item => item.ref)).toEqual(['q1', 'e1'])
    state = navigateBack(state)
    expect(state.current?.ref).toBe('v1')
    state = navigateTo(state, { datasetId: 'ks_other', ref: 'q2' })
    expect(state).toEqual({ datasetId: 'ks_other', current: { datasetId: 'ks_other', ref: 'q2' }, back: [] })
  })

  it('preserves selection only when the same dataset still contains the exact id', () => {
    const state = createNavigation(dataset, 'q1')
    expect(keepSelectionForSnapshot(state, dataset, new Set(['q1']))).toEqual({ state, missingPrevious: false })
    const missing = keepSelectionForSnapshot(state, dataset, new Set(['q2']))
    expect(missing.missingPrevious).toBe(true)
    expect(missing.state.current).toBeUndefined()
    expect(keepSelectionForSnapshot(state, 'ks_other', new Set(['q1'])).missingPrevious).toBe(false)
  })
})

describe('knowledge-ref/1', () => {
  it('serializes compact JSON and validates dataset, ref, snapshot, evidence and Vault-relative path', () => {
    const encoded = serializeKnowledgeReference({
      path: 'research/example.knowledge.json', dataset, ref: 'q1', snapshot: 'a'.repeat(64), evidence: 'x1',
    })
    expect(encoded).not.toContain('\n')
    expect(parseKnowledgeReference(encoded)).toEqual({
      format: 'knowledge-ref/1', path: 'research/example.knowledge.json', dataset, ref: 'q1', snapshot: 'a'.repeat(64), evidence: 'x1',
    })
    for (const value of [
      '{}',
      JSON.stringify({ format: 'knowledge-ref/1', path: '../secret', dataset, ref: 'q1' }),
      JSON.stringify({ format: 'knowledge-ref/1', path: 'a.json', dataset: 'ks_bad', ref: 'q1' }),
      JSON.stringify({ format: 'knowledge-ref/1', path: 'a.json', dataset, ref: 's1' }),
      JSON.stringify({ format: 'knowledge-ref/1', path: 'a.json', dataset, ref: 'q1', extra: true }),
    ]) expect(parseKnowledgeReference(value)).toBeNull()
  })

  it('never substitutes a same-named object when restoring changed data', () => {
    const reference = parseKnowledgeReference(serializeKnowledgeReference({
      path: 'research/example.knowledge.json', dataset, ref: 'q1', snapshot: 'a'.repeat(64),
    }))!
    expect(assessKnowledgeReference(reference, { datasetId: dataset, snapshotHash: 'a'.repeat(64), availableIds: new Set(['q1']) }).status).toBe('ready')
    expect(assessKnowledgeReference(reference, { datasetId: 'ks_123', availableIds: new Set(['q1']) }).status).toBe('dataset-mismatch')
    expect(assessKnowledgeReference(reference, { datasetId: dataset, snapshotHash: 'b'.repeat(64), availableIds: new Set(['q1']) }).status).toBe('snapshot-changed')
    expect(assessKnowledgeReference(reference, { datasetId: dataset, snapshotHash: 'a'.repeat(64), availableIds: new Set(['q2']) }).status).toBe('missing-ref')
  })
})
