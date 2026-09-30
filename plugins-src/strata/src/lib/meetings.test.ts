import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import fixture from '../../../knowledge-browser/fixtures/minimal-valid.json'
import { adaptMeetingSnapshot } from './meetings'
import type { KnowledgeDataset } from '../../../knowledge-browser/src/lib/types'
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

  it('separates attributed speakers from semantic objects and keeps the complete source record', async () => {
    const value = structuredClone(fixture) as unknown as KnowledgeDataset
    value.events = []; value.narratives = []; value.relations = []
    value.concepts[0].aliases = ['发布许可']
    value.entities.push({ ...value.entities[1], id: 'e3', type: 'system', name: '发布平台', aliases: ['交付系统'] })
    value.claims[0].about = ['c1', 'e3']
    value.claims[0].text = '工程负责人讨论发布批准权与发布平台。'
    const result = await adaptMeetingSnapshot(snapshot([document(undefined, value)]), range)
    const claim = result.nodes.find(node => node.meeting.localId === 'q1')!
    const speaker = result.nodes.find(node => node.meeting.localId === 'e1')!
    expect(claim.topicTerms).toEqual(['发布批准权', '发布许可', '发布平台', '交付系统'])
    expect(claim.features.some(term => term.includes('工程负责人'))).toBe(false)
    expect(claim.links.map(id => id.split(':').at(-1))).toEqual(['c1', 'e3'])
    expect(claim.speaker).toBe('工程负责人')
    expect(claim.meeting.record).toEqual(value.claims[0])
    expect(claim.meeting.references.some(ref => ref.localId === 'e1')).toBe(true)
    expect(claim.meeting.evidence[0].speaker).toEqual({ id: 'e1', name: '工程负责人' })
    expect(speaker.features).toEqual([]); expect(speaker.topicTerms).toEqual([])
    expect(claim.topicSourceId).toBe('meeting:' + hash(document().path))
    expect(claim.sourceGroups).toHaveLength(1)
  })

  it('retains people linked by explicit about and named relationship roles, not by alone', async () => {
    const value = structuredClone(fixture) as unknown as KnowledgeDataset
    value.claims[0].about = ['e2', 'c1']
    const result = await adaptMeetingSnapshot(snapshot([document(undefined, value)]), range)
    const claim = result.nodes.find(node => node.meeting.localId === 'q1')!
    expect(claim.links.some(id => id.endsWith(':e1'))).toBe(false)
    expect(claim.links.some(id => id.endsWith(':e2'))).toBe(true)
    expect(claim.topicTerms).toEqual(['发布批准权'])
    expect(result.relations[0].participants.map(({ role }) => role)).toEqual(['delegator', 'delegate', 'work'])
    expect(result.relations[0].meeting.record).toEqual(value.relations[0])
    const person = result.nodes.find(node => node.meeting.localId === 'e1')!
    expect(person.links.some(id => id.endsWith(':e2'))).toBe(true)
    expect(person.links.some(id => id.endsWith(':v1'))).toBe(true)
  })

  it('never gives same-named people cross-meeting lexical features or topic labels', async () => {
    const result = await adaptMeetingSnapshot(snapshot([document(), document('ssot/meetings/other/knowledge.json')]), range)
    const people = result.nodes.filter(node => node.meeting.kind === 'entities' && 'type' in node.meeting.record && node.meeting.record.type === 'person')
    expect(people).toHaveLength(4)
    expect(new Set(people.map(node => node.id)).size).toBe(4)
    expect(people.every(node => !node.features.length && !node.topicTerms.length)).toBe(true)
    expect(new Set(people.map(node => node.topicSourceId)).size).toBe(2)
    for (const node of people) expect(node.links.every(id => id.startsWith(node.topicSourceId + ':'))).toBe(true)
  })

  it('uses bounded original concept terms and non-person aliases without inventing categories', async () => {
    const value = structuredClone(fixture) as unknown as KnowledgeDataset
    value.concepts[0].term = '工程负责人批准权'
    value.concepts[0].aliases = ['工程负责人', 'e1', '发布许可', ...Array.from({ length: 40 }, (_, i) => '许可别名' + i)]
    const result = await adaptMeetingSnapshot(snapshot([document(undefined, value)]), range)
    const concept = result.nodes.find(node => node.meeting.localId === 'c1')!
    expect(concept.topicTerms[0]).toBe('工程负责人批准权')
    expect(concept.topicTerms).toContain('发布许可')
    expect(concept.topicTerms).not.toContain('工程负责人')
    expect(concept.topicTerms).not.toContain('e1')
    expect(concept.topicTerms.length).toBeLessThanOrEqual(24)
    expect(concept.meeting.record).toEqual(value.concepts[0])
    expect(concept).not.toHaveProperty('category')
  })


  it('removes an explicit Latin person name without corrupting unrelated words', async () => {
    const value = structuredClone(fixture) as unknown as KnowledgeDataset
    value.entities[0].name = 'Al'
    value.claims[0].text = 'Al discusses algorithm reliability'
    const result = await adaptMeetingSnapshot(snapshot([document(undefined, value)]), range)
    const claim = result.nodes.find(node => node.meeting.localId === 'q1')!
    expect(claim.features).toContain('discusses algorithm reliability')
    expect(claim.topicTerms).not.toContain('Al')
  })


  it('conservatively excludes a batch-declared person name without merging cross-meeting identities', async () => {
    const first = structuredClone(fixture) as unknown as KnowledgeDataset
    first.entities.push({ ...first.entities[1], id: 'e3', type: 'system', name: 'Alex', aliases: ['ＡＬＥＸ', '产品平台'] })
    first.claims[0].about = ['e3', 'c1']
    const second = structuredClone(first)
    second.entities[2].type = 'person'
    second.entities[2].aliases = ['ＡＬＥＸ']
    const result = await adaptMeetingSnapshot(snapshot([document(undefined, first), document('ssot/meetings/other/knowledge.json', second)]), range)
    const system = result.nodes.find(node => node.meeting.localId === 'e3' && node.meeting.datasetPath === document().path)!
    expect(system.meeting.record).toEqual(first.entities[2])
    expect(system.topicTerms).toEqual(['产品平台'])
    expect(system.features).toEqual(['产品平台'])
    expect(result.nodes.every(node => !node.topicTerms.some(term => term.normalize('NFKC').toLowerCase() === 'alex'))).toBe(true)
    expect(result.nodes.every(node => !node.features.some(term => term.normalize('NFKC').toLowerCase() === 'alex'))).toBe(true)
    expect(result.nodes.filter(node => node.meeting.localId === 'e3')).toHaveLength(2)
    expect(result.nodes).toHaveLength(14)
    expect(result.relations).toHaveLength(4)
    expect(result.nodes.every(node => node.sourceGroups.length === 1)).toBe(true)
  })

})
