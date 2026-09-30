import { describe, expect, it } from 'vitest'
import { nodeVisible, rangeError, recentRange, restorePreferences, sourceFilesForNode, supportsExtraction } from './domain'
import type { KnowledgeNode, Provider, SourceFile } from './types'
describe('browser scope and provider gate', () => {
  it('uses inclusive local civil dates and rejects normalized invalid dates', () => {
    expect(recentRange(7, new Date(2026, 8, 30, 0, 1))).toEqual({ from: '2026-09-24', to: '2026-09-30' })
    expect(rangeError('2024-02-29', '2024-02-29')).toBe('')
    expect(rangeError('2026-02-29', '2026-03-01')).not.toBe('')
    expect(rangeError('2026-10-01', '2026-09-30')).not.toBe('')
  })
  it('requires the precise isolated task and terminal results', () => {
    const p: Provider = { id: 'p', name: 'P', harness: { ok: true, capabilities: { tasks: ['strata-extract-v1'], terminal_result: true, input_only_isolation: true } } }
    expect(supportsExtraction(p)).toBe(true)
    p.harness!.capabilities!.input_only_isolation = false
    expect(supportsExtraction(p)).toBe(false)
    p.harness!.capabilities!.input_only_isolation = true
    p.harness!.capabilities!.tasks = ['agency-observe-v1']
    expect(supportsExtraction(p)).toBe(false)
  })
  it('hides only explicitly public material and respects source dates', () => {
    const node = { confidentiality: 'unknown', sourceGroups: [{ dates: ['2026-09-20', '2026-09-30'] }] } as KnowledgeNode
    const scope = { from: '2026-09-30', to: '2026-09-30', includePublic: false }
    expect(nodeVisible(node, scope)).toBe(true)
    expect(nodeVisible({ ...node, confidentiality: 'explicitly_public' }, scope)).toBe(false)
    expect(nodeVisible(node, { ...scope, from: '2026-09-21', to: '2026-09-29' })).toBe(false)
  })
  it('does not restore invalid persisted ranges or unsafe scale', () => {
    expect(restorePreferences({ from: '2026-99-01', to: '2026-10-01', verticalScale: 999 }).verticalScale).toBe(1.8)
    expect(restorePreferences({ from: '2026-99-01', to: '2026-10-01' }).from).not.toBe('2026-99-01')
  })
})

it('lists only in-range copies of a content-deduplicated source', () => {
  const node = { sourceGroups: [{ groupId: 'source:same-hash' }], evidence: [] } as unknown as KnowledgeNode
  const files = [
    { fileKey: 'a', contentHash: 'same-hash', docDate: '2026-09-01' },
    { fileKey: 'b', contentHash: 'same-hash', docDate: '2026-09-30' },
    { fileKey: 'c', contentHash: 'same-hash', docDate: null },
  ] as SourceFile[]
  expect(sourceFilesForNode(files, node, { from: '2026-09-30', to: '2026-09-30' }).map(f => f.fileKey)).toEqual(['b'])
})
