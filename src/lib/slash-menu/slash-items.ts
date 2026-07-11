import type { EditorView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { t } from '../i18n/store.svelte'
import { setBlock, wrapBlock, wrapList, insertAtom, insertTable, insertTaskList } from '../context-menu/block-helpers'
import { iconSvg } from '../context-menu/icons'

// NOTE: Do NOT import commands from '@moraya/core/commands' here.
// commands.js uses its own defaultSchema (nullMediaResolver) which is a
// different instance from the editor's schema. ProseMirror compares NodeType
// by identity, so those commands silently fail (canReplaceWith returns false).
// Every execute function obtains node types from view.state.schema directly.

export interface SlashItem {
  id: string
  label: string
  keywords: string[]
  icon: string
  desc: string
  execute: (view: EditorView) => void | Promise<void>
}

// ── schema-aware helpers ──────────────────────────────────────────────────────

function insertSpreadsheetSync(v: EditorView) {
  const { schema } = v.state
  const spreadsheet = schema.nodes.spreadsheet
  if (!spreadsheet) return
  const defaultCsv = '列A,列B,列C\n,,\n,,\n,,'
  v.dispatch(
    v.state.tr
      .replaceSelectionWith(spreadsheet.create({ source: defaultCsv }))
      .scrollIntoView()
  )
  v.focus()
}

/** Wrap the selection (empty at the slash position) in literal delimiters and
 *  put the caret between them, matching how these marks are typed by hand. */
function wrapLiteral(v: EditorView, prefix: string, suffix: string) {
  const { from, to } = v.state.selection
  const text = v.state.doc.textBetween(from, to) || ''
  const tr = v.state.tr.insertText(`${prefix}${text}${suffix}`, from, to)
  const caret = text ? from + prefix.length + text.length + suffix.length : from + prefix.length
  tr.setSelection(TextSelection.create(tr.doc, caret))
  v.dispatch(tr)
  v.focus()
}

// ── item definitions ──────────────────────────────────────────────────────────

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif']
const DOC_EXTS   = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
                    'zip', 'gz', 'tar', 'rar', '7z',
                    'mp3', 'wav', 'ogg', 'flac',
                    'mp4', 'mov', 'avi', 'mkv', 'webm',
                    'txt', 'csv', 'json', 'xml']

// Built lazily (as a function, not a module-level const) so labels/descriptions
// reflect the current locale — switching language rebuilds them on next open.
// `keywords` intentionally keep both English and Chinese terms so search works
// regardless of the UI language.
export function getSlashItems(): SlashItem[] {
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
    execute: (v) => wrapLiteral(v, '^^', '^^'),
  },
  {
    id: 'wikilink',
    label: t('slash.wikilink.label'),
    keywords: ['wikilink', 'link', 'wiki', '双链', '链接'],
    icon: iconSvg('wikilink'),
    desc: t('slash.wikilink.desc'),
    execute: (v) => wrapLiteral(v, '[[', ']]'),
  },
  {
    id: 'insert-image',
    label: t('slash.image.label'),
    keywords: ['image', 'photo', '图片', '图像', 'picture', 'insert'],
    icon: 'img',
    desc: t('slash.image.desc'),
    execute: async (v) => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const result = await open({
        multiple: false,
        filters: [{ name: t('slash.filter.images'), extensions: IMAGE_EXTS }],
      })
      if (typeof result !== 'string') return
      const { insertImageAtCursor } = await import('../attachment-insert')
      insertImageAtCursor(v, result)
    },
  },
  {
    id: 'insert-doc',
    label: t('slash.doc.label'),
    keywords: ['document', 'file', 'attach', '文档', '文件', '附件'],
    icon: 'doc',
    desc: t('slash.doc.desc'),
    execute: async (v) => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const result = await open({
        multiple: false,
        filters: [{ name: t('slash.filter.docs'), extensions: DOC_EXTS }],
      })
      if (typeof result !== 'string') return
      const { insertAttachmentLink } = await import('../attachment-insert')
      insertAttachmentLink(v, result)
    },
  },
  {
    id: 'h1',
    label: t('slash.h1.label'),
    keywords: ['h1', 'heading', '标题', '一级', 'heading1'],
    icon: 'H1',
    desc: t('slash.h1.desc'),
    execute: (v) => setBlock(v, 'heading', { level: 1 }),
  },
  {
    id: 'h2',
    label: t('slash.h2.label'),
    keywords: ['h2', 'heading', '标题', '二级', 'heading2'],
    icon: 'H2',
    desc: t('slash.h2.desc'),
    execute: (v) => setBlock(v, 'heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: t('slash.h3.label'),
    keywords: ['h3', 'heading', '标题', '三级', 'heading3'],
    icon: 'H3',
    desc: t('slash.h3.desc'),
    execute: (v) => setBlock(v, 'heading', { level: 3 }),
  },
  {
    id: 'quote',
    label: t('slash.quote.label'),
    keywords: ['quote', 'blockquote', '引用', '引言', 'block'],
    icon: '❝',
    desc: t('slash.quote.desc'),
    execute: (v) => wrapBlock(v, 'blockquote'),
  },
  {
    id: 'code',
    label: t('slash.code.label'),
    keywords: ['code', 'codeblock', '代码', 'programming', 'pre'],
    icon: '{}',
    desc: t('slash.code.desc'),
    execute: (v) => setBlock(v, 'code_block', { language: '' }),
  },
  {
    id: 'mermaid',
    label: t('slash.mermaid.label'),
    keywords: ['mermaid', 'diagram', 'chart', '图表', '流程图', '时序图', 'flowchart'],
    icon: '⬡',
    desc: t('slash.mermaid.desc'),
    execute: (v) => setBlock(v, 'code_block', { language: 'mermaid' }),
  },
  {
    id: 'math',
    label: t('slash.math.label'),
    keywords: ['math', 'equation', 'latex', '数学', '公式', 'formula'],
    icon: '∑',
    desc: t('slash.math.desc'),
    execute: (v) => insertAtom(v, 'math_block', { value: '' }),
  },
  {
    id: 'table',
    label: t('slash.table.label'),
    keywords: ['table', '表格', 'grid'],
    icon: '▦',
    desc: t('slash.table.desc'),
    execute: (v) => insertTable(v),
  },
  {
    id: 'spreadsheet',
    label: t('slash.spreadsheet.label'),
    keywords: ['spreadsheet', 'sheet', 'csv', '表格', '电子表格', '记账', 'excel'],
    icon: '⊞',
    desc: t('slash.spreadsheet.desc'),
    execute: (v) => insertSpreadsheetSync(v),
  },
  {
    id: 'bullet',
    label: t('slash.bullet.label'),
    keywords: ['bullet', 'list', 'ul', '列表', '无序', '项目'],
    icon: '•',
    desc: t('slash.bullet.desc'),
    execute: (v) => wrapList(v, 'bullet_list'),
  },
  {
    id: 'ordered',
    label: t('slash.ordered.label'),
    keywords: ['ordered', 'list', 'ol', '列表', '有序', '编号', 'numbered'],
    icon: '1.',
    desc: t('slash.ordered.desc'),
    execute: (v) => wrapList(v, 'ordered_list'),
  },
  {
    id: 'task',
    label: t('slash.task.label'),
    keywords: ['task', 'todo', 'checklist', '任务', '待办', '清单', 'checkbox'],
    icon: '☐',
    desc: t('slash.task.desc'),
    execute: (v) => insertTaskList(v),
  },
  {
    id: 'hr',
    label: t('slash.hr.label'),
    keywords: ['hr', 'divider', 'rule', '分割', '横线', 'horizontal'],
    icon: '—',
    desc: t('slash.hr.desc'),
    execute: (v) => insertAtom(v, 'horizontal_rule'),
  },
  ]
}

export function filterSlashItems(query: string): SlashItem[] {
  const items = getSlashItems()
  if (!query) return items
  const q = query.toLowerCase()
  return items.filter(item =>
    item.label.toLowerCase().includes(q) ||
    item.keywords.some(k => k.toLowerCase().includes(q))
  )
}
