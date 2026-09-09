import { describe, expect, it } from 'vitest'
import { parseTimeline } from './parser'

const document = (body: string, metadata = 'type: Timeline') => `---\n${metadata}\n---\n${body}\n`
const event = '- 09:00:00–10:00:00 — 开发：实现时间轴。 [会话](../agent/example.md#line10)'

describe('timeline parser', () => {
  it('preserves long activity labels for keyword classification', () => {
    const action = '项目'.repeat(24) + '代码审阅'
    expect(parseTimeline(document(`- 09:00–10:00 — ${action}：检查变更。`))?.items[0].action).toBe(action)
  })

  it('reads the observed diary structure, preserving context, sources and nested topics', () => {
    const source = document(`# 2026-09-08 Timeline

UTC+8；活动范围不代表连续投入时长。

- 09:00:00–10:00:00 — 会议：讨论产品计划。 [会议](../meetings/example.md#line10)
  - 09:10:30–09:30:45 — 议题：确认发布范围。 [议题来源](../meetings/example.md#line20)
- 09:15:00–11:00:00 — 开发：实现时间轴。 [会话](../agent/example.md)
- 11:15:00–11:15:00 — 阅读：阅读一篇文章。 [文章](../reading/example.md)`, `type: Timeline
title: "2026-09-08 Timeline"
description: "当日摘要"
generated:
  by: example/timeline
  at: "2026-09-08T21:08:18Z"
tags: [每日时间线, 回忆索引]
timezone: Asia/Shanghai
sources:
  - id: source1
    resource: ../meetings/example.md`)
    const parsed = parseTimeline(source, '/vault/diary/2026-09-08.timeline.md')

    expect(parsed).toMatchObject({
      title: '2026-09-08 Timeline', date: '2026-09-08', description: '当日摘要',
      notes: ['UTC+8；活动范围不代表连续投入时长。'],
    })
    expect(parsed?.items).toHaveLength(3)
    expect(parsed?.items[0]).toMatchObject({
      start: 540, end: 600, action: '会议', text: '讨论产品计划。',
      links: [{ label: '会议', target: '../meetings/example.md#line10' }],
      children: [{
        start: 550.5, end: 570.75, action: '议题', text: '确认发布范围。',
        links: [{ label: '议题来源', target: '../meetings/example.md#line20' }], children: [],
      }],
    })
    expect(parsed?.items[1]).toMatchObject({ start: 555, end: 660, action: '开发' })
    expect(parsed?.items[2]).toMatchObject({ start: 675, end: 675, action: '阅读' })
  })

  it('accepts an observed empty day without inventing events', () => {
    expect(parseTimeline(document('# 2026-06-07 Timeline\n\n没有可回源的活动。'))).toMatchObject({
      title: '2026-06-07 Timeline', items: [], notes: ['没有可回源的活动。'],
    })
  })

  it.each(['timeline', 'Timeline', 'TIMELINE', '" Timeline "'])('recognizes type %s', type => {
    expect(parseTimeline(document(event, `type: ${type}`))?.items).toHaveLength(1)
  })

  it.each(['type: note', 'type: [Timeline]', 'type: true', 'title: Timeline', 'Timeline'])('rejects unsupported metadata %s', metadata => {
    expect(parseTimeline(document(event, metadata))).toBeNull()
  })

  it('requires complete, valid YAML and rejects duplicate type keys', () => {
    expect(parseTimeline(event)).toBeNull()
    expect(parseTimeline(`---\ntype: Timeline\n${event}`)).toBeNull()
    expect(parseTimeline(document(event, 'type: [Timeline'))).toBeNull()
    expect(parseTimeline(document(event, 'type: note\ntype: Timeline'))).toBeNull()
  })

  it('does not mistake a YAML field containing --- for the closing delimiter', () => {
    const parsed = parseTimeline(document(event, `type: Timeline
title: "Before---after"
description: |
  This paragraph contains --- inside YAML.
  ---
  And continues here.`))
    expect(parsed?.title).toBe('Before---after')
    expect(parsed?.description).toBe('This paragraph contains --- inside YAML.\n---\nAnd continues here.\n')
    expect(parsed?.items).toHaveLength(1)
  })

  it('accepts BOM and CRLF input without corrupting seconds or link fragments', () => {
    const parsed = parseTimeline(`\uFEFF${document(event).replace(/\n/g, '\r\n')}`)
    expect(parsed?.items[0]).toMatchObject({
      start: 540, end: 600, links: [{ label: '会话', target: '../agent/example.md#line10' }],
    })
  })

  it('keeps overlapping events and sorts top-level entries chronologically', () => {
    const parsed = parseTimeline(document(`- 09:30–10:30 — 沟通：跟进计划。
- 09:15–09:15 — 阅读：一条即时记录。
${event}`))
    expect(parsed?.items.map(item => [item.action, item.start, item.end])).toEqual([
      ['开发', 540, 600], ['阅读', 555, 555], ['沟通', 570, 630],
    ])
  })

  it('attaches siblings and deeper topics to their own parent', () => {
    const parsed = parseTimeline(document(`${event}
  - 09:10–09:20 — 议题：第一项。
    - 09:15–09:15 — 核查：检查结果。
  - 09:20–09:30 — 议题：第二项。
- 11:00–12:00 — 会议：另一场会议。
  - 11:10–11:20 — 议题：独立的子项。`))
    expect(parsed?.items).toHaveLength(2)
    expect(parsed?.items[0].children.map(item => item.text)).toEqual(['第一项。', '第二项。'])
    expect(parsed?.items[0].children[0].children[0].text).toBe('检查结果。')
    expect(parsed?.items[1].children.map(item => item.text)).toEqual(['独立的子项。'])
  })

  it.each([
    '  - 09:10–09:20 — 议题：没有父项。',
    `${event}\n  - 08:59–09:20 — 议题：起点超出父项。`,
    `${event}\n  - 09:10–10:01 — 议题：终点超出父项。`,
  ])('rejects orphaned or out-of-range children', body => {
    expect(parseTimeline(document(body))).toBeNull()
  })

  it.each([
    '- 25:00–26:00 — 开发：小时非法。',
    '- 09:60–10:00 — 开发：分钟非法。',
    '- 09:00:60–10:00:00 — 开发：秒数非法。',
    '- 10:00–09:00 — 开发：倒序时段。',
    '- 23:00–24:01 — 开发：超出当天。',
    '- 23:00:00–24:00:01 — 开发：超出当天。',
    '- 09:00 — 开发：不支持的单时间点。',
    '- 09:00–10:00 开发：缺少描述分隔符。',
    '- 09:00–10:00 — ',
    '- 09:00–10:00 — [只有来源](../source.md)',
    '- 未知格式的活动',
    '1. 10:00–11:00 — 开发：不支持的编号列表。',
    '10:00–11:00 — 开发：缺少列表标记。',
  ])('falls back for the entire day if any event is invalid: %s', invalid => {
    expect(parseTimeline(document(`${event}\n${invalid}`))).toBeNull()
  })

  it('accepts exactly 24:00 as the end of a day', () => {
    const parsed = parseTimeline(document('- 23:59:30–24:00:00 — 阅读：读完一篇文章。'))
    expect(parsed?.items[0]).toMatchObject({ start: 1439.5, end: 1440 })
  })

  it('extracts Markdown formatting and multiple source links as plain structured data', () => {
    const parsed = parseTimeline(document('- 09:00–10:00 — **开发**：实现 `Timeline` 并做 *检查*。 [第一条](../source.md#line2) [第二条](../with\\(parens\\).md)'))
    expect(parsed?.items[0]).toMatchObject({
      action: '开发', text: '实现 Timeline 并做 检查。',
      links: [{ label: '第一条', target: '../source.md#line2' }, { label: '第二条', target: '../with(parens).md' }],
    })
  })

  it('keeps bare URLs and email addresses inside the description instead of source buttons', () => {
    const parsed = parseTimeline(document('- 09:00–10:00 — 沟通：查看 https://example.test/info，并联系 alice@example.test 完成确认。 [来源](../note.md#L2)'))
    expect(parsed?.items[0]).toMatchObject({
      action: '沟通', text: '查看 https://example.test/info，并联系 alice@example.test 完成确认。',
      links: [{ label: '来源', target: '../note.md#L2' }],
    })
  })

  it('falls back for unsupported tables without showing a partially parsed day', () => {
    expect(parseTimeline(document(`${event}
| 时间 | 活动 |
| --- | --- |
| 10:00–11:00 | 沟通：确认计划。 |`))).toBeNull()
  })

  it.each(['#', '##', '######'])('falls back for unsupported timed %s headings', heading => {
    expect(parseTimeline(document(`${event}\n${heading} 10:00–11:00 沟通：确认计划。`))).toBeNull()
  })

  it('keeps HTML-shaped content literal and never returns rendered HTML', () => {
    const parsed = parseTimeline(document('- 09:00–10:00 — 开发：<img src=x onerror="alert(1)"> <script>alert(2)</script>'))
    expect(parsed?.items[0]).toMatchObject({
      action: '开发', text: '<img src=x onerror="alert(1)"> <script>alert(2)</script>', links: [],
    })
    expect(parsed?.items[0]).not.toHaveProperty('html')
  })

  it('preserves fenced examples and prose as notes without treating them as activities', () => {
    const parsed = parseTimeline(document(`这里是时间线说明。
\`\`\`markdown
- 25:00–26:00 — 示例：代码内的格式不作为活动。
\`\`\`
${event}
这里是补充说明。`))
    expect(parsed?.items).toHaveLength(1)
    expect(parsed?.notes).toEqual([
      '这里是时间线说明。', '```markdown', '- 25:00–26:00 — 示例：代码内的格式不作为活动。', '```', '这里是补充说明。',
    ])
  })

  it.each([
    ['```markdown', '~~~', '```'],
    ['~~~markdown', '```', '~~~'],
    ['````markdown', '```', '`````'],
    ['~~~~markdown', '~~~', '~~~~'],
    ['```markdown', '```not-a-closing-fence', '```'],
  ])('closes %s only with a matching fence of sufficient length', (opening, falseClosing, closing) => {
    const sample = '- 25:00–26:00 — 示例：这段仍属于代码块。'
    const parsed = parseTimeline(document(`${opening}\n${falseClosing}\n${sample}\n${closing}\n${event}`))
    expect(parsed?.items).toHaveLength(1)
    expect(parsed?.items[0].action).toBe('开发')
    expect(parsed?.notes).toEqual([opening, falseClosing, sample, closing])
  })

  it('derives dates from the file URI, or falls back to metadata', () => {
    expect(parseTimeline(document(event, 'type: Timeline\ndate: 2026-09-07'), '/diary/2026-09-08.timeline.md')?.date).toBe('2026-09-08')
    expect(parseTimeline(document(event, 'type: Timeline\ndate: 2026-09-07'))?.date).toBe('2026-09-07')
    expect(parseTimeline(document(event, 'type: Timeline\ntitle: 2026-09-06 Timeline'))?.date).toBe('2026-09-06')
  })
})
