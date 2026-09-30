import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import fixture from '../../../knowledge-browser/fixtures/minimal-valid.json'
import { adaptMeetingSnapshot } from './meetings'
import type { MeetingDocument, MeetingSnapshotInput } from './meetings'

const range = { from: '2026-09-01', to: '2026-09-30' }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const document = (path = 'ssot/meetings/test/knowledge.json', value: unknown = fixture, date: string | null = '2026-09-15'): MeetingDocument => {
  const content = typeof value === 'string' ? value : JSON.stringify(value)
  return { path, content, contentHash: hash(content), date, dateInferred: false }
}
const snapshot = (documents = [document()]): MeetingSnapshotInput => ({ schema: 'notemd.strata/meetings/v1', vaultKey: 'vault', datasetKey: 'meetings', snapshotId: 'snapshot', documents, diagnostics: [], missingKnowledge: 2 })

describe('meeting dataset adapter', () => {
  it('uses five peak kinds and per-object core/supporting contribution without claiming proof', async () => {
    const result = await adaptMeetingSnapshot(snapshot(), range)
    expect(result.nodes).toHaveLength(6)
    expect(new Set(result.nodes.map(node => node.kind))).toEqual(new Set(['entity', 'concept', 'claim', 'event', 'narrative']))
    expect(new Set(result.nodes.map(node => node.meeting.kind))).toEqual(new Set(['entities', 'concepts', 'claims', 'events', 'narratives']))
    expect(result.relations).toHaveLength(2)
    expect(result.meetings).toMatchObject({ datasets: 1, missingKnowledge: 2, invalidFiles: 0, isolatedRecords: 0, rawRecords: 8, usableRecords: 8, relations: 2 })
    for (const node of result.nodes) {
      expect(node.state).toBe('imported'); expect(node.ownerSpecificity).toBe('unknown'); expect(node.confidentiality).toBe('unknown')
      expect(node.evidence).toEqual([])
      expect(node.sourceGroups).toEqual([{ groupId: node.id, groupVersion: document().contentHash, priority: node.importance === 0 ? 2 : 1, dates: ['2026-09-15'], canonicalIds: [node.id] }])
      expect(node.meeting.evidence.length).toBeGreaterThan(0)
      expect(node.meeting).not.toHaveProperty('sourceText'); expect(node.meeting).not.toHaveProperty('dataset')
    }
    expect(result.nodes.find(node => node.meeting.localId === 'q1')?.meeting.record).toMatchObject({ valid: null, limits: ['规则有效期未说明'], by: ['e1'] })
  })

  it('namespaces local IDs by file path and keeps all roles in multi-participant relations', async () => {
    const first = document(), second = document('ssot/meetings/other/knowledge.json')
    const result = await adaptMeetingSnapshot(snapshot([first, second]), range)
    expect(new Set(result.nodes.map(node => node.id)).size).toBe(12)
    const prefix = 'meeting:' + hash(first.path) + ':'
    const relation = result.relations.find(item => item.id === prefix + 'r1')!
    expect(relation.participants).toEqual([{ nodeId: prefix + 'e1', role: 'delegator' }, { nodeId: prefix + 'e2', role: 'delegate' }, { nodeId: prefix + 'v1', role: 'work' }])
    expect(relation.meeting.record).toHaveProperty('args')
    expect(result.nodes.every(node => node.links.every(link => link.startsWith(node.id.slice(0, node.id.lastIndexOf(':') + 1))))).toBe(true)
  })

  it('isolates invalid records and never connects them through remaining relations', async () => {
    const value = structuredClone(fixture); value.entities[0].i = 7
    const result = await adaptMeetingSnapshot(snapshot([document(undefined, value)]), range)
    expect(result.meetings.isolatedRecords).toBeGreaterThan(0)
    expect(result.nodes.some(node => node.meeting.localId === 'e1')).toBe(false)
    expect(result.nodes.flatMap(node => node.links).some(id => id.endsWith(':e1'))).toBe(false)
    expect(result.relations.flatMap(item => item.participants).some(item => item.nodeId.endsWith(':e1'))).toBe(false)
  })

  it('reports invalid JSON, duplicate keys, unsupported schemas and content hash drift', async () => {
    const bad = document('ssot/meetings/a/knowledge.json', '{"schema":"a","schema":"b"}')
    const unsupported = document('ssot/meetings/b/knowledge.json', { ...fixture, schema: 'knowledge-representation-dataset/9.0.0' })
    const drift = { ...document('ssot/meetings/c/knowledge.json'), contentHash: '0'.repeat(64) }
    const result = await adaptMeetingSnapshot(snapshot([bad, unsupported, drift]), range)
    expect(result.nodes).toEqual([]); expect(result.relations).toEqual([])
    expect(result.meetings.invalidFiles).toBe(3)
    expect(result.meetings.diagnostics.some(item => item.code === 'snapshot.hash')).toBe(true)
    await expect(adaptMeetingSnapshot(snapshot([document(), document()]), range)).rejects.toThrow('重复文件')
  })

  it('keeps full atlas membership across date ranges and does not replace missing dates with generated time', async () => {
    const input = snapshot([document(), document('ssot/meetings/undated/knowledge.json', fixture, null)])
    const a = await adaptMeetingSnapshot(input, range), b = await adaptMeetingSnapshot(input, { from: '2026-09-24', to: '2026-09-30' })
    expect(a.nodes).toEqual(b.nodes)
    expect(a.coverage.selected).toBe(1); expect(b.coverage.selected).toBe(0)
    expect(a.meetings.dateExtent).toEqual({ from: '2026-09-15', to: '2026-09-15' })
    expect(a.nodes.filter(node => node.meeting.datasetPath.includes('/undated/')).every(node => node.sourceGroups[0].dates.length === 0)).toBe(true)
  })

  it('bounds diagnostic output while retaining total counts', async () => {
    const input = snapshot([]); input.diagnostics = Array.from({ length: 120 }, () => ({ code: 'skip', message: 'x'.repeat(1000) }))
    const result = await adaptMeetingSnapshot(input, range)
    expect(result.meetings.diagnosticCount).toBe(120); expect(result.meetings.diagnostics).toHaveLength(80)
    expect(result.meetings.diagnostics.every(item => item.message.length <= 512)).toBe(true)
  })
})
