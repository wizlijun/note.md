import { describe, expect, it } from 'vitest'
import { en } from '../i18n/en'
import { zh } from '../i18n/zh'
import {
  groupPluginsByCategory,
  isSystemPluginCategory,
  normalizePluginCategory,
  pluginAiRole,
  pluginCategoryLabelKey,
  PLUGIN_CATEGORY_ORDER,
} from './categories'

describe('plugin capability categories', () => {
  it('uses the documented top-level category order', () => {
    expect(PLUGIN_CATEGORY_ORDER).toEqual([
      'ai', 'record', 'reading', 'create', 'advance', 'reflect', 'import-export', 'experience',
    ])
  })

  it('labels the eight groups consistently in Chinese and English', () => {
    const keys = PLUGIN_CATEGORY_ORDER.map(pluginCategoryLabelKey)
    expect(keys.map((key) => zh[key])).toEqual(['AI', '捕捉', '阅读', '写作', '推进', '回顾', '数据导入导出', '其他'])
    expect(keys.map((key) => en[key])).toEqual(['AI', 'Capture', 'Read', 'Write', 'Advance', 'Review', 'Import & Export', 'Other'])
  })

  it('keeps the fixed capability order and stable input order within a group', () => {
    const rows = [
      { id: 'reading', category: 'reading' },
      { id: 'third.agent-b', category: 'advance' },
      { id: 'third.agent-a', category: 'advance' },
      { id: 'third.record', category: 'record' },
      { id: 'third.create', category: 'create' },
    ]
    const groups = groupPluginsByCategory(rows)
    expect(groups.map((group) => group.key)).toEqual([
      'record', 'reading', 'create', 'advance',
    ])
    expect(groups[3].items.map((row) => row.id)).toEqual(['third.agent-b', 'third.agent-a'])
  })

  it('merges legacy inspiration, existing creation and cached Sumi into one group', () => {
    const rows = [{ id: 'third', category: 'inspiration' }, { id: 'notemd.sumi', category: 'experience' }, { id: 'notemd.idea-spark', category: 'capture' }, { id: 'writer', category: 'create' }]
    expect(groupPluginsByCategory(rows)).toEqual([{ key: 'create', items: rows }])
  })

  it('sends unknown and missing categories to Other', () => {
    expect(normalizePluginCategory('future-category')).toBe('experience')
    expect(normalizePluginCategory(null)).toBe('experience')
    expect(groupPluginsByCategory([
      { id: 'unknown', category: 'future-category' },
      { id: 'missing' },
    ])).toEqual([{ key: 'experience', items: [
      { id: 'unknown', category: 'future-category' },
      { id: 'missing' },
    ] }])
  })

  it('keeps Other last', () => {
    expect(PLUGIN_CATEGORY_ORDER.at(-1)).toBe('experience')
  })

  it('maps previous category keys to their closest current category', () => {
    expect(normalizePluginCategory('inspiration')).toBe('create')
    expect(normalizePluginCategory('other')).toBe('experience')
    expect(normalizePluginCategory('experience', 'notemd.sumi')).toBe('create')
    expect(normalizePluginCategory('agents')).toBe('ai')
    expect(normalizePluginCategory('capture')).toBe('record')
    expect(normalizePluginCategory('thinking-review')).toBe('reflect')
    expect(normalizePluginCategory('publish-export')).toBe('import-export')
    expect(normalizePluginCategory('editor-extensions')).toBe('experience')
  })

  it('uses official plugin ids to migrate ambiguous cached categories', () => {
    expect(normalizePluginCategory('advance', 'notemd.claude-agent')).toBe('ai')
    expect(normalizePluginCategory('advance', 'notemd.codex-agent')).toBe('ai')
    expect(normalizePluginCategory('advance', 'notemd.deepseek-agent')).toBe('ai')
    expect(normalizePluginCategory('editing', 'notemd.conversation-dictionary')).toBe('ai')
    expect(normalizePluginCategory('reflect', 'notemd.memory')).toBe('ai')
    expect(normalizePluginCategory('capture', 'notemd.idea-spark')).toBe('create')
    expect(normalizePluginCategory('capture', 'notemd.trace-source')).toBe('reading')
    expect(normalizePluginCategory('thinking', 'notemd.next')).toBe('advance')
    expect(normalizePluginCategory('thinking', 'notemd.weekly-review')).toBe('reflect')
    expect(normalizePluginCategory(undefined, 'notemd.timeline')).toBe('reflect')
    expect(normalizePluginCategory('import-export', 'notemd.roam-import')).toBe('record')
    expect(normalizePluginCategory('create', 'notemd.md2pdf')).toBe('import-export')
    expect(normalizePluginCategory('editing', 'notemd.power-mode')).toBe('experience')
  })

  it.each(['notemd.apple-notes', 'notemd.roam-import', 'notemd.health-sync'])('places %s in Capture regardless of cached category', (id) => {
    expect(normalizePluginCategory('import-export', id)).toBe('record')
    expect(normalizePluginCategory(undefined, id)).toBe('record')
  })

  it('identifies only host-level categories as system features', () => {
    expect(isSystemPluginCategory('ai')).toBe(true)
    expect(isSystemPluginCategory('import-export')).toBe(true)
    expect(isSystemPluginCategory('experience')).toBe(true)
    expect(isSystemPluginCategory('create')).toBe(false)
  })

  it('declares AI roles only for plugins that directly provide AI collaboration', () => {
    expect(pluginAiRole('notemd.ebook-import')).toBe('read')
    expect(pluginAiRole('notemd.idea-spark')).toBe('inspire')
    expect(pluginAiRole('notemd.trace-source')).toBe('reason')
    expect(pluginAiRole('notemd.codex-agent')).toBe('execute')
    expect(pluginAiRole('notemd.next')).toBeNull()
  })
})
