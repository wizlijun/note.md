import type { EditorView } from 'prosemirror-view'
import { setBlockType, wrapIn } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'

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
  execute: (view: EditorView) => void
}

// ── schema-aware helpers ──────────────────────────────────────────────────────

function setBlock(v: EditorView, typeName: string, attrs?: Record<string, unknown>) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  setBlockType(type, attrs)(v.state, v.dispatch)
  v.focus()
}

function wrap(v: EditorView, typeName: string) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  wrapIn(type)(v.state, v.dispatch)
  v.focus()
}

function wrapList(v: EditorView, typeName: string) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  wrapInList(type)(v.state, v.dispatch)
  v.focus()
}

function insertAtom(v: EditorView, typeName: string, attrs?: Record<string, unknown>) {
  const type = v.state.schema.nodes[typeName]
  if (!type) return
  v.dispatch(v.state.tr.replaceSelectionWith(type.create(attrs ?? {})).scrollIntoView())
  v.focus()
}

function insertTableSync(v: EditorView) {
  const { schema } = v.state
  const { table, table_header_row, table_row, table_header, table_cell, paragraph } = schema.nodes
  if (!table || !table_header_row || !table_row || !table_header || !table_cell || !paragraph) return

  const rows = 3, cols = 3
  const emptyPara  = () => paragraph.createAndFill()!
  const headerCell = () => table_header.createAndFill({ alignment: 'left' }, [emptyPara()])!
  const bodyCell   = () => table_cell.createAndFill(  { alignment: 'left' }, [emptyPara()])!

  const tableNode = table.create(null, [
    table_header_row.create(null, Array.from({ length: cols }, headerCell)),
    ...Array.from({ length: rows - 1 }, () =>
      table_row.create(null, Array.from({ length: cols }, bodyCell))
    ),
  ])

  v.dispatch(v.state.tr.replaceSelectionWith(tableNode).scrollIntoView())
  v.focus()
}

function wrapTaskList(v: EditorView) {
  const { schema } = v.state
  const bulletList = schema.nodes.bullet_list
  const listItem   = schema.nodes.list_item
  if (!bulletList || !listItem) return

  if (!wrapInList(bulletList)(v.state, v.dispatch)) return

  // Set checked: false on newly-wrapped list items
  const { doc, selection } = v.state
  const { from, to } = selection
  const tr = v.state.tr
  doc.nodesBetween(
    Math.max(0, from - 200),
    Math.min(doc.content.size, to + 200),
    (node, pos) => {
      if (node.type === listItem && node.attrs.checked === null) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false })
      }
    },
  )
  if (tr.docChanged) v.dispatch(tr)
  v.focus()
}

// ── item definitions ──────────────────────────────────────────────────────────

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'h1',
    label: '标题 1',
    keywords: ['h1', 'heading', '标题', '一级', 'heading1'],
    icon: 'H1',
    desc: '一级大标题',
    execute: (v) => setBlock(v, 'heading', { level: 1 }),
  },
  {
    id: 'h2',
    label: '标题 2',
    keywords: ['h2', 'heading', '标题', '二级', 'heading2'],
    icon: 'H2',
    desc: '二级标题',
    execute: (v) => setBlock(v, 'heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: '标题 3',
    keywords: ['h3', 'heading', '标题', '三级', 'heading3'],
    icon: 'H3',
    desc: '三级标题',
    execute: (v) => setBlock(v, 'heading', { level: 3 }),
  },
  {
    id: 'quote',
    label: '引用',
    keywords: ['quote', 'blockquote', '引用', '引言', 'block'],
    icon: '❝',
    desc: '引用块',
    execute: (v) => wrap(v, 'blockquote'),
  },
  {
    id: 'code',
    label: '代码块',
    keywords: ['code', 'codeblock', '代码', 'programming', 'pre'],
    icon: '{}',
    desc: '带语法高亮的代码块',
    execute: (v) => setBlock(v, 'code_block', { language: '' }),
  },
  {
    id: 'mermaid',
    label: 'Mermaid 图表',
    keywords: ['mermaid', 'diagram', 'chart', '图表', '流程图', '时序图', 'flowchart'],
    icon: '⬡',
    desc: '流程图、时序图、甘特图…',
    execute: (v) => setBlock(v, 'code_block', { language: 'mermaid' }),
  },
  {
    id: 'math',
    label: '数学公式',
    keywords: ['math', 'equation', 'latex', '数学', '公式', 'formula'],
    icon: '∑',
    desc: 'LaTeX 数学公式块',
    execute: (v) => insertAtom(v, 'math_block', { value: '' }),
  },
  {
    id: 'table',
    label: '表格',
    keywords: ['table', '表格', 'grid'],
    icon: '▦',
    desc: '3×3 可编辑表格',
    execute: (v) => insertTableSync(v),
  },
  {
    id: 'bullet',
    label: '无序列表',
    keywords: ['bullet', 'list', 'ul', '列表', '无序', '项目'],
    icon: '•',
    desc: '无序列表',
    execute: (v) => wrapList(v, 'bullet_list'),
  },
  {
    id: 'ordered',
    label: '有序列表',
    keywords: ['ordered', 'list', 'ol', '列表', '有序', '编号', 'numbered'],
    icon: '1.',
    desc: '有序列表',
    execute: (v) => wrapList(v, 'ordered_list'),
  },
  {
    id: 'task',
    label: '任务列表',
    keywords: ['task', 'todo', 'checklist', '任务', '待办', '清单', 'checkbox'],
    icon: '☐',
    desc: '任务清单 / Todo',
    execute: (v) => wrapTaskList(v),
  },
  {
    id: 'hr',
    label: '分割线',
    keywords: ['hr', 'divider', 'rule', '分割', '横线', 'horizontal'],
    icon: '—',
    desc: '水平分割线',
    execute: (v) => insertAtom(v, 'horizontal_rule'),
  },
]

export function filterSlashItems(query: string): SlashItem[] {
  if (!query) return SLASH_ITEMS
  const q = query.toLowerCase()
  return SLASH_ITEMS.filter(item =>
    item.label.toLowerCase().includes(q) ||
    item.keywords.some(k => k.toLowerCase().includes(q))
  )
}
