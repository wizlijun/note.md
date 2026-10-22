import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { editTimelineEvent, type EventEdit } from './edit-document'
import { parseTimeline, type TimelineItem } from './parser'
import fixtures from './fixtures/event-importance.json'

const upgraded = fixtures.find(fixture => fixture.name === 'independent nested topics')!.content
const legacy = '---\ntype: Timeline\n# untouched comment\ncustom: {quoted: "keep me"}\n---\n# Day\n\n- 09:00:00–10:00:00 — **会议**：确认 **交付**。 [来源](../source.md#L12 "原始标题")\n  - 09:10–09:20 — 议题：例行检查。\n\n说明原文。\n\n```md\n- 13:00–14:00 — 示例：不是事件。\n```\n'
const flatten = (items: TimelineItem[]): TimelineItem[] => items.flatMap(item => [item, ...flatten(item.children)])
const first = (source: string) => parseTimeline(source)!.items[0]
function draft(item: TimelineItem): EventEdit {
  const stamp = (time: number) => `${String(Math.floor(time / 60)).padStart(2, '0')}:${String(Math.floor(time % 60)).padStart(2, '0')}:${String(Math.round(time % 1 * 60)).padStart(2, '0')}`
  return { start: stamp(item.start), end: stamp(item.end), title: item.action, text: item.text, importance: item.metadata.importance }
}
function edit(source: string, changes: Partial<EventEdit>, id = first(source).id): string {
  const item = flatten(parseTimeline(source)!.items).find(value => value.id === id)!
  return editTimelineEvent(source, id, { ...draft(item), ...changes })
}
const metadata = (source: string) => parseDocument(source.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).slice(1).join('\n').split('\n---')[0]).toJS()

describe('source-preserving Timeline event edits', () => {
  it.each([legacy, upgraded, '\uFEFF' + legacy.replace(/\n/g, '\r\n')])('keeps a no-op byte identical', source => {
    expect(edit(source, {})).toBe(source)
  })

  it('changes just time tokens, keeping precision, separators, metadata, Markdown and code examples', () => {
    expect(edit(legacy, { start: '08:55:30' })).toBe(legacy.replace('09:00:00–10:00:00', '08:55:30–10:00:00'))
    expect(edit(upgraded, { end: '10:10:15' })).toBe(upgraded.replace('09:00:00–10:00:00', '09:00:00–10:10:15'))
  })

  it('changes the title while preserving the description Markdown and source link bytes', () => {
    expect(edit(legacy, { title: '交付复盘' })).toBe(legacy.replace('**会议**：', '交付复盘：'))
  })

  it('changes the description while preserving title formatting and original source links', () => {
    const result = edit(legacy, { text: '确认 *新范围* [非链接](x)。' })
    expect(result).toContain('**会议**：确认 \\*新范围\\* \\[非链接\\](x)。 [来源](../source.md#L12 "原始标题")')
    expect(first(result).text).toBe('确认 *新范围* [非链接](x)。')
    expect(first(result).links).toEqual(first(legacy).links)
  })

  it('normalizes a wrapper crossing both edited fields without losing visible content or links', () => {
    const source = legacy.replace('**会议**：确认 **交付**。', '**会议：确认交付。**')
    const result = edit(source, { title: '复盘' })
    expect(first(result)).toMatchObject({ action: '复盘', text: '确认交付。', links: first(source).links })
  })

  it('preserves links anywhere in the changed fields, including Markdown inside link labels', () => {
    const source = legacy.replace('**会议**：确认 **交付**。 [来源](../source.md#L12 "原始标题")', '[首个](../a.md) 会议：确认 [**第二个**](../b.md "标题") 交付。 [尾部](../c.md)')
    const result = edit(source, { title: '新标题', text: '新内容' })
    expect(first(result)).toMatchObject({ action: '新标题', text: '新内容', links: first(source).links })
    for (const link of ['[首个](../a.md)', '[**第二个**](../b.md "标题")', '[尾部](../c.md)']) expect(result).toContain(link)
  })

  it('updates nested events by stable ID without modifying the parent or siblings', () => {
    const result = edit(upgraded, { start: '09:11', title: '核查' }, 'e02')
    expect(result).toBe(upgraded.replace('09:10:00–09:20:00 — 议题', '09:11–09:20:00 — 核查'))
  })

  it('permits adding a title to a title-less event and clearing only one text field', () => {
    const source = '---\ntype: timeline\n---\n- 09:00–10:00 — 原描述 [来源](x.md)\n'
    expect(first(edit(source, { title: '活动' }))).toMatchObject({ action: '活动', text: '原描述' })
    expect(first(edit(legacy, { title: '' }))).toMatchObject({ action: '', text: '确认 交付。' })
    expect(first(edit(legacy, { text: '' }))).toMatchObject({ action: '会议', text: '' })
  })

  it('upgrades every real legacy event to stable IDs only on an importance change', () => {
    const before = flatten(parseTimeline(legacy)!.items)
    const result = edit(legacy, { importance: 'high' })
    const after = flatten(parseTimeline(result)!.items)
    expect(after.map(item => item.id)).toEqual(before.map(item => item.id))
    expect(after[0].metadata).toMatchObject({ importance: 'high', importance_origin: 'manual', reason: '用户手动设置重要程度。', evidence: [], signals: before[0].metadata.signals })
    expect(after[1].metadata).toMatchObject({ importance: 'unknown', reason: '此活动尚未评定重要程度。' })
    expect(after[1].metadata).not.toHaveProperty('importance_origin')
    expect(result).toContain('# untouched comment\ncustom: {quoted: "keep me"}\n')
    expect(result).toContain('```md\n- 13:00–14:00 — 示例：不是事件。\n```')
    expect(Object.keys(metadata(result).event_metadata)).toEqual(before.map(item => item.id))
  })

  it('preserves BOM and CRLF while adding metadata and editing text', () => {
    const source = '\uFEFF' + legacy.replace(/\n/g, '\r\n')
    const result = edit(source, { importance: 'normal', title: '复盘', text: '确认事项。' })
    expect(result.startsWith('\uFEFF---\r\n')).toBe(true)
    expect(result.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(first(result)).toMatchObject({ action: '复盘', text: '确认事项。', metadata: { importance: 'normal', importance_origin: 'manual' } })
  })

  it('marks a manual change without recomputing independent evidence, signals or anomaly', () => {
    const source = upgraded.replace('    signals:\n', '    anomaly:\n      status: flagged\n      reason: 明显偏离\n      evidence: [{source: s01, locator: L12}]\n    signals:\n')
    const before = first(source).metadata
    const result = edit(source, { importance: 'normal', start: '08:00' })
    const after = first(result).metadata
    expect(after).toEqual({ ...before, importance: 'normal', importance_origin: 'manual', reason: '用户手动设置重要程度。' })
    expect(metadata(result).event_metadata.e02).toEqual(metadata(source).event_metadata.e02)
  })

  it('keeps frontmatter bytes outside event_metadata including comments and custom quoted values', () => {
    const source = upgraded.replace('event_metadata:', '# before metadata\nevent_metadata:').replace('\n---\n-', '\n# afterwards\ncustom: {x: "verbatim"}\n---\n-')
    const result = edit(source, { importance: 'unknown' })
    expect(result.slice(0, result.indexOf('event_metadata:'))).toBe(source.slice(0, source.indexOf('event_metadata:')))
    expect(result.slice(result.indexOf('# afterwards'))).toBe(source.slice(source.indexOf('# afterwards')))
  })

  it('updates flow-style event_metadata and retains its trailing comment', () => {
    const source = '---\ntype: timeline\nevent_metadata: {e1: {importance: unknown, reason: pending, evidence: [], signals: {source_chars: null, duration_minutes: null, owner_relation: unknown}}} # retain\nother: "quoted"\n---\n- 09:00–10:00 — 活动：内容。 <!-- event:e1 -->\n'
    const result = edit(source, { importance: 'high' })
    expect(first(result).metadata).toMatchObject({ importance: 'high', importance_origin: 'manual', evidence: [] })
    expect(result).toContain(' # retain\nother: "quoted"\n')
  })

  it('does not change metadata when its importance selection is unchanged', () => {
    expect(edit(upgraded, { title: '新标题' })).toBe(upgraded.replace('— 会议：', '— 新标题：'))
    expect(first(edit(upgraded, { title: '新标题' })).metadata).not.toHaveProperty('importance_origin')
  })

  it('marks legacy events manually as anomalous without inventing source evidence, and keeps nested IDs stable', () => {
    const before = flatten(parseTimeline(legacy)!.items)
    const result = edit(legacy, { anomaly: 'flagged' })
    const after = flatten(parseTimeline(result)!.items)
    expect(after.map(item => item.id)).toEqual(before.map(item => item.id))
    expect(after[0].metadata).toMatchObject({ importance: 'unknown', anomaly: { status: 'flagged', origin: 'manual', reason: '用户手动设置反常标签。', evidence: [] } })
    expect(after[0].metadata).not.toHaveProperty('importance_origin')
    expect(after[1].metadata).not.toHaveProperty('anomaly')
    expect(result).toContain('# untouched comment\ncustom: {quoted: "keep me"}\n')
    expect(result).toContain('```md\n- 13:00–14:00 — 示例：不是事件。\n```')
    expect(edit(legacy, { anomaly: 'unknown' })).toBe(legacy)
  })

  it('sets and clears nested anomaly independently while preserving evidence, extra fields, parent and sibling metadata', () => {
    const source = upgraded.replaceAll('    signals:\n', '    anomaly:\n      status: flagged\n      reason: 明显偏离\n      evidence: [{source: s01, locator: L12}]\n      custom: "keep anomaly"\n    custom_metadata: {quoted: "keep metadata"}\n    signals:\n')
    const originalMetadata = metadata(source).event_metadata
    const result = edit(source, { anomaly: 'none' }, 'e02')
    const resultMetadata = metadata(result).event_metadata
    expect(resultMetadata.e01).toEqual(originalMetadata.e01)
    expect(resultMetadata.e03).toEqual(originalMetadata.e03)
    expect(resultMetadata.e02).toEqual({ ...originalMetadata.e02, anomaly: { ...originalMetadata.e02.anomaly, status: 'none', origin: 'manual', reason: '用户手动设置反常标签。' } })
    const unknown = edit(result, { anomaly: 'unknown' }, 'e02')
    expect(flatten(parseTimeline(unknown)!.items).find(item => item.id === 'e02')!.metadata.anomaly?.status).toBe('unknown')
    expect(metadata(unknown).event_metadata.e02.anomaly.evidence).toEqual(originalMetadata.e02.anomaly.evidence)
    expect(edit(unknown, { anomaly: 'unknown' }, 'e02')).toBe(unknown)
  })

  it('detaches an aliased anomaly before editing so another event is not changed', () => {
    const source = upgraded.replace('    signals:\n', '    anomaly: &shared\n      status: none\n      reason: 原判断\n      evidence: []\n      extra: 保留\n    signals:\n').replace('    evidence: *a1\n', '    evidence: *a1\n    anomaly: *shared\n')
    const result = edit(source, { anomaly: 'flagged' }, 'e02')
    expect(metadata(result).event_metadata.e01.anomaly).toEqual(metadata(source).event_metadata.e01.anomaly)
    expect(metadata(result).event_metadata.e02.anomaly).toMatchObject({ status: 'flagged', origin: 'manual', evidence: [], extra: '保留' })
  })

  it('keeps unchanged explicitly selected anomalies byte identical instead of converting them to manual', () => {
    const source = fixtures.find(fixture => fixture.name === 'high with flagged anomaly')!.content
    expect(edit(source, { anomaly: 'flagged' })).toBe(source)
    expect(edit(source, { anomaly: 'flagged', title: '新标题' })).toBe(source.replace('— 会议：', '— 新标题：'))
  })

  it('preserves aliased child judgments when editing the anchored parent anomaly', () => {
    const source = upgraded.replace('    signals:\n', '    anomaly: &shared\n      status: none\n      reason: 原判断\n      evidence: []\n      extra: 保留\n    signals:\n').replace('    evidence: *a1\n', '    evidence: *a1\n    anomaly: *shared # child judgment\n')
    const result = edit(source, { anomaly: 'flagged' }, 'e01')
    expect(metadata(result).event_metadata.e01.anomaly).toMatchObject({ status: 'flagged', origin: 'manual', extra: '保留' })
    expect(metadata(result).event_metadata.e02).toEqual(metadata(source).event_metadata.e02)
    expect(result).toContain('# child judgment')
  })

  it('combines manual importance and anomaly changes while preserving BOM and CRLF', () => {
    const source = '\uFEFF' + legacy.replace(/\n/g, '\r\n')
    const result = edit(source, { anomaly: 'flagged', importance: 'normal', title: '复盘' })
    expect(result.startsWith('\uFEFF---\r\n')).toBe(true)
    expect(result.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/)
    expect(first(result).metadata).toMatchObject({ importance: 'normal', importance_origin: 'manual', anomaly: { status: 'flagged', origin: 'manual', evidence: [] } })
    expect(() => edit(legacy, { anomaly: 'invalid' as EventEdit['anomaly'] })).toThrow(/反常/)
  })

  it.each(['09:60', '25:00', '24:00:01', '9', '09:00\n', '09:00:99'])('rejects invalid time %s', start => {
    expect(() => edit(legacy, { start })).toThrow(/时间/)
  })
  it.each([
    { start: '10:30' },
    { end: '09:15' },
    { title: '', text: '' },
    { title: '活动：注入' },
    { title: '两行\n内容' },
    { text: '两行\n内容' },
    { text: '控制\u0000字符' },
    { title: '', text: '描述：内容' },
    { importance: 'invalid' as EventEdit['importance'] },
  ])('rejects invalid edits without returning a partially rewritten document: %j', changes => {
    expect(() => edit(legacy, changes)).toThrow()
  })

  it('rejects a nested event outside its parent range', () => {
    expect(() => edit(upgraded, { start: '08:59' }, 'e02')).toThrow(/子活动/)
  })

  it('supports the end-of-day boundary and seconds', () => {
    const source = '---\ntype: timeline\n---\n- 23:00–23:59 — 活动：内容\n'
    expect(first(edit(source, { start: '23:10:01', end: '24:00' }))).toMatchObject({ start: 1390 + 1 / 60, end: 1440 })
  })

  it('rejects stale IDs and invalid documents', () => {
    expect(() => editTimelineEvent(legacy, 'missing', draft(first(legacy)))).toThrow(/变更或删除/)
    expect(() => editTimelineEvent('invalid', first(legacy).id, draft(first(legacy)))).toThrow(/有效的时间轴/)
  })
})

describe('manual importance parsing', () => {
  const manual = (origin: string) => `---\ntype: timeline\nevent_metadata:\n  e1:\n    importance: high\n    importance_origin: ${origin}\n    reason: 用户手动设置重要程度。\n    evidence: []\n    signals: {source_chars: null, duration_minutes: null, owner_relation: unknown}\n---\n- 09:00–10:00 — 活动：内容 <!-- event:e1 -->\n`
  it('accepts an explicitly manual assessment without claiming source evidence', () => {
    expect(first(manual('manual')).metadata).toMatchObject({ importance_origin: 'manual', importance: 'high', evidence: [] })
  })
  it.each(['automatic', 'null', 'true', '[]', '{}', 'Manual', '""'])('rejects invalid importance origin %s', origin => {
    expect(parseTimeline(manual(origin))).toBeNull()
  })
  it('still requires evidence for generated high importance and validates manual evidence', () => {
    expect(parseTimeline(manual('manual').replace('    importance_origin: manual\n', ''))).toBeNull()
    expect(parseTimeline(manual('manual').replace('evidence: []', 'evidence: [{source: missing, locator: invalid}]'))).toBeNull()
  })
})

describe('manual anomaly parsing', () => {
  const manual = (origin: string) => `---
type: timeline
event_metadata:
  e1:
    importance: unknown
    reason: 待判断
    evidence: []
    signals: {source_chars: null, duration_minutes: null, owner_relation: unknown}
    anomaly:
      status: flagged
      origin: ${origin}
      reason: 用户手动设置反常标签。
      evidence: []
---
- 09:00–10:00 — 活动：内容 <!-- event:e1 -->
`
  it('allows explicitly manual flagged anomalies with no evidence and validates all supplied evidence', () => {
    expect(first(manual('manual')).metadata.anomaly).toMatchObject({ status: 'flagged', origin: 'manual', evidence: [] })
    expect(parseTimeline(manual('manual').replace('      origin: manual\n', ''))).toBeNull()
    expect(parseTimeline(manual('manual').replace('      evidence: []', '      evidence: [{source: missing, locator: L1}]'))).toBeNull()
  })
  it.each(['automatic', 'null', 'true', '[]', '{}', 'Manual', '""'])('rejects invalid anomaly origin %s', origin => {
    expect(parseTimeline(manual(origin))).toBeNull()
  })
})
