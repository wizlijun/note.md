import type { Diff, Snapshot, Version } from './types'

// Synthetic data used only by tests. Production never imports a fixture.
export function fixture(id = 'current'): Snapshot {
  return {
    meta: { schema: 'vault-knowledge-structure/1', snapshotId: id, stateHash: id, parents: [], generatedAt: '2026-09-30T07:00:00Z', vaultId: 'fixture-vault', algorithm: { version: 'habitat-local/1', parserVersion: 'parser/1', tokenizerVersion: 'tokenizer/1', effectiveParams: {} }, scopeHash: 'scope', manifestHash: 'manifest', structureHash: 'structure', evidenceHash: 'evidence', layoutHash: 'layout', coverage: { indexed: 2, parsed: 2, unavailable: 0, excluded: 0, knowledgeDatasets: 0, knowledgeRecords: 0, importedRecords: 0, isolatedRecords: 0, unprojectedRecords: 0, diagnosticCount: 0, unassignedSources: 0, unresolvedLinks: 0, diagnostics: [] }, changeCause: 'content' },
    sources: [{ id: 's1', path: 'fixture/research.md', hash: 'hash', role: 'source', status: 'matched', family: 'f1', familyStatus: 'verified' }],
    nodes: [{ id: 'n1', key: 'n1', nodeType: 'project', label: '纸船计划', aliases: ['Paperboat'], status: 'candidate', evidence: ['e1'] }, { id: 'n2', key: 'n2', nodeType: 'concept', label: '观察与反馈', status: 'candidate', evidence: ['e2'] }, { id: 't1', key: 't1', nodeType: 'topic', label: '研究方法', status: 'candidate', evidence: [] }],
    evidence: [{ id: 'e1', source: 's1', locator: { start: 7, end: 11, outlineId: 'outline-1' }, role: 'mentions', authorship: 'human', granularity: 'node', verification: 'matched' }, { id: 'e2', source: 's1', locator: { start: 15, end: 18 }, role: 'mentions', authorship: 'unknown', granularity: 'paragraph', verification: 'matched' }],
    edges: [{ id: 'r1', edgeType: 'wikilink', status: 'observed', participants: [{ node: 'n1', role: 'source' }, { node: 'n2', role: 'target' }], evidence: ['e1'], verifiedFamilies: 1, provisionalFamilies: 0, unresolvedLineage: 0 }],
    memberships: [{ id: 'm1', node: 'n2', topic: 't1', role: 'secondary', score: .4 }], lineage: [],
    layout: [{ id: 'n1', x: 60, y: 40, zone: 'project', pinned: false }, { id: 'n2', x: 130, y: 60, zone: 'knowledge', pinned: false }, { id: 't1', x: 100, y: 130, zone: 'knowledge', pinned: false }],
  }
}
export const versions: Version[] = [{ commit: 'commit-current', snapshotId: 'current', parents: ['old'], generatedAt: '2026-09-30T07:00:00Z', changeCause: 'content', nodes: 3, edges: 1 }, { commit: 'commit-old', snapshotId: 'old', parents: [], generatedAt: '2026-09-29T07:00:00Z', changeCause: 'initial', nodes: 2, edges: 0 }]
export const difference: Diff = { from: 'old', to: 'current', causes: ['content'], comparable: true, warnings: [], added: [fixture().nodes[1]], removed: [], renamed: [{ id: 'n1', before: '纸船构思', after: '纸船计划' }], changed: [], edgesAdded: fixture().edges, edgesRemoved: [], edgesChanged: [], membershipChanges: 1, layoutChanges: 0 }
