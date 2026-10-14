import type { EditorView } from 'prosemirror-view'
import { t } from '../i18n/runtime.svelte'
import { runSlashCommand } from './slash-command'
import { iconSvg } from '../context-menu/icons'

// Legacy commands from '@moraya/core/commands' may use their own defaultSchema
// (nullMediaResolver), a different instance from the editor's schema. ProseMirror
// compares NodeType by identity, so use view.state.schema helpers for those
// commands to avoid silent canReplaceWith failures. gfmTableCommand and its
// insertTable wrapper are schema-local exceptions; this menu's insertTable
// helper delegates to that shared GFM command.

export interface SlashItem {
  id: string
  label: string
  keywords: string[]
  icon: string
  desc: string
  execute: (view: EditorView) => void | Promise<void>
}

// ── item definitions ──────────────────────────────────────────────────────────

// Built lazily (as a function, not a module-level const) so labels/descriptions
// reflect the current locale — switching language rebuilds them on next open.
// `keywords` intentionally keep both English and Chinese terms so search works
// regardless of the UI language.
export function getCommonSlashItems(): SlashItem[] {
  return [
  {
    id: 'insert-note',
    label: t('slash.note.label'),
    keywords: ['note', 'comment', 'annotation', '批注', '注释', '备注', '笔记'],
    icon: iconSvg('sparkle'),
    desc: t('slash.note.desc'),
    execute: async (v) => {
      const { insertNoteRich } = await import('../note-anno/note-commands')
      insertNoteRich(v)
    },
  },
  {
    id: 'highlight',
    label: t('slash.highlight.label'),
    keywords: ['highlight', 'mark', '高亮', '荧光'],
    icon: iconSvg('highlight'),
    desc: t('slash.highlight.desc'),
    execute: (v) => { runSlashCommand(v, 'highlight') },
  },
  {
    id: 'wikilink',
    label: t('slash.wikilink.label'),
    keywords: ['wikilink', 'link', 'wiki', '双链', '链接'],
    icon: iconSvg('wikilink'),
    desc: t('slash.wikilink.desc'),
    execute: (v) => { runSlashCommand(v, 'wikilink') },
  },
  {
    id: 'h1',
    label: t('slash.h1.label'),
    keywords: ['h1', 'heading', '标题', '一级', 'heading1'],
    icon: 'H1',
    desc: t('slash.h1.desc'),
    execute: (v) => { runSlashCommand(v, 'h1') },
  },
  {
    id: 'h2',
    label: t('slash.h2.label'),
    keywords: ['h2', 'heading', '标题', '二级', 'heading2'],
    icon: 'H2',
    desc: t('slash.h2.desc'),
    execute: (v) => { runSlashCommand(v, 'h2') },
  },
  {
    id: 'h3',
    label: t('slash.h3.label'),
    keywords: ['h3', 'heading', '标题', '三级', 'heading3'],
    icon: 'H3',
    desc: t('slash.h3.desc'),
    execute: (v) => { runSlashCommand(v, 'h3') },
  },
  {
    id: 'quote',
    label: t('slash.quote.label'),
    keywords: ['quote', 'blockquote', '引用', '引言', 'block'],
    icon: '❝',
    desc: t('slash.quote.desc'),
    execute: (v) => { runSlashCommand(v, 'quote') },
  },
  {
    id: 'code',
    label: t('slash.code.label'),
    keywords: ['code', 'codeblock', '代码', 'programming', 'pre'],
    icon: '{}',
    desc: t('slash.code.desc'),
    execute: (v) => { runSlashCommand(v, 'code') },
  },
  {
    id: 'mermaid',
    label: t('slash.mermaid.label'),
    keywords: ['mermaid', 'diagram', 'chart', '图表', '流程图', '时序图', 'flowchart'],
    icon: '⬡',
    desc: t('slash.mermaid.desc'),
    execute: (v) => { runSlashCommand(v, 'mermaid') },
  },
  {
    id: 'math',
    label: t('slash.math.label'),
    keywords: ['math', 'equation', 'latex', '数学', '公式', 'formula'],
    icon: '∑',
    desc: t('slash.math.desc'),
    execute: (v) => { runSlashCommand(v, 'math') },
  },
  {
    id: 'table',
    label: t('slash.table.label'),
    keywords: ['table', '表格', 'grid'],
    icon: '▦',
    desc: t('slash.table.desc'),
    execute: (v) => { runSlashCommand(v, 'table') },
  },
  {
    id: 'spreadsheet',
    label: t('slash.spreadsheet.label'),
    keywords: ['spreadsheet', 'sheet', 'csv', '表格', '电子表格', '记账', 'excel'],
    icon: '⊞',
    desc: t('slash.spreadsheet.desc'),
    execute: (v) => { runSlashCommand(v, 'spreadsheet') },
  },
  {
    id: 'bullet',
    label: t('slash.bullet.label'),
    keywords: ['bullet', 'list', 'ul', '列表', '无序', '项目'],
    icon: '•',
    desc: t('slash.bullet.desc'),
    execute: (v) => { runSlashCommand(v, 'bullet') },
  },
  {
    id: 'ordered',
    label: t('slash.ordered.label'),
    keywords: ['ordered', 'list', 'ol', '列表', '有序', '编号', 'numbered'],
    icon: '1.',
    desc: t('slash.ordered.desc'),
    execute: (v) => { runSlashCommand(v, 'ordered') },
  },
  {
    id: 'task',
    label: t('slash.task.label'),
    keywords: ['task', 'todo', 'checklist', '任务', '待办', '清单', 'checkbox'],
    icon: '☐',
    desc: t('slash.task.desc'),
    execute: (v) => { runSlashCommand(v, 'task') },
  },
  {
    id: 'hr',
    label: t('slash.hr.label'),
    keywords: ['hr', 'divider', 'rule', '分割', '横线', 'horizontal'],
    icon: '—',
    desc: t('slash.hr.desc'),
    execute: (v) => { runSlashCommand(v, 'hr') },
  },
  ]
}

export function filterSlashItems(query: string, items = getCommonSlashItems()): SlashItem[] {
  if (!query) return items
  const q = query.toLowerCase()
  return items.filter(item =>
    item.label.toLowerCase().includes(q) ||
    item.keywords.some(k => k.toLowerCase().includes(q))
  )
}

const shareAllowed = new Set(['insert-note', 'highlight', 'wikilink', 'h1', 'h2', 'h3', 'quote', 'code', 'mermaid', 'math', 'table', 'bullet', 'ordered', 'task', 'hr'])
export function getShareSlashItems(): SlashItem[] { return getCommonSlashItems().filter(item => shareAllowed.has(item.id)) }
