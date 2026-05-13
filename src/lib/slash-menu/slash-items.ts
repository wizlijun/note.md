import type { EditorView } from 'prosemirror-view'
import {
  setHeading,
  toggleCodeBlock,
  insertMathBlock,
  insertTable,
  toggleBlockquote,
  wrapInBulletList,
  wrapInOrderedList,
  wrapInTaskList,
  insertHorizontalRule,
} from '@moraya/core/commands'

export interface SlashItem {
  id: string
  label: string
  keywords: string[]
  icon: string
  desc: string
  execute: (view: EditorView) => void
}

function run(
  view: EditorView,
  command: (state: import('prosemirror-state').EditorState, dispatch: (tr: import('prosemirror-state').Transaction) => void) => boolean,
) {
  command(view.state, view.dispatch)
  view.focus()
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: 'h1',
    label: '标题 1',
    keywords: ['h1', 'heading', '标题', '一级', 'heading1'],
    icon: 'H1',
    desc: '一级大标题',
    execute: (v) => run(v, setHeading(1)),
  },
  {
    id: 'h2',
    label: '标题 2',
    keywords: ['h2', 'heading', '标题', '二级', 'heading2'],
    icon: 'H2',
    desc: '二级标题',
    execute: (v) => run(v, setHeading(2)),
  },
  {
    id: 'h3',
    label: '标题 3',
    keywords: ['h3', 'heading', '标题', '三级', 'heading3'],
    icon: 'H3',
    desc: '三级标题',
    execute: (v) => run(v, setHeading(3)),
  },
  {
    id: 'quote',
    label: '引用',
    keywords: ['quote', 'blockquote', '引用', '引言', 'block'],
    icon: '❝',
    desc: '引用块',
    execute: (v) => run(v, toggleBlockquote),
  },
  {
    id: 'code',
    label: '代码块',
    keywords: ['code', 'codeblock', '代码', 'programming', 'pre'],
    icon: '{}',
    desc: '带语法高亮的代码块',
    execute: (v) => run(v, toggleCodeBlock),
  },
  {
    id: 'mermaid',
    label: 'Mermaid 图表',
    keywords: ['mermaid', 'diagram', 'chart', '图表', '流程图', '时序图', 'flowchart'],
    icon: '⬡',
    desc: '流程图、时序图、甘特图…',
    execute: (v) => {
      const cb = v.state.schema.nodes.code_block
      if (!cb) return
      v.dispatch(v.state.tr.replaceSelectionWith(cb.create({ language: 'mermaid' })).scrollIntoView())
      v.focus()
    },
  },
  {
    id: 'math',
    label: '数学公式',
    keywords: ['math', 'equation', 'latex', '数学', '公式', 'formula'],
    icon: '∑',
    desc: 'LaTeX 数学公式块',
    execute: (v) => run(v, insertMathBlock),
  },
  {
    id: 'table',
    label: '表格',
    keywords: ['table', '表格', 'grid'],
    icon: '▦',
    desc: '3×3 可编辑表格',
    execute: (v) => run(v, insertTable),
  },
  {
    id: 'bullet',
    label: '无序列表',
    keywords: ['bullet', 'list', 'ul', '列表', '无序', '项目'],
    icon: '•',
    desc: '无序列表',
    execute: (v) => run(v, wrapInBulletList),
  },
  {
    id: 'ordered',
    label: '有序列表',
    keywords: ['ordered', 'list', 'ol', '列表', '有序', '编号', 'numbered'],
    icon: '1.',
    desc: '有序列表',
    execute: (v) => run(v, wrapInOrderedList),
  },
  {
    id: 'task',
    label: '任务列表',
    keywords: ['task', 'todo', 'checklist', '任务', '待办', '清单', 'checkbox'],
    icon: '☐',
    desc: '任务清单 / Todo',
    execute: (v) => run(v, wrapInTaskList),
  },
  {
    id: 'hr',
    label: '分割线',
    keywords: ['hr', 'divider', 'rule', '分割', '横线', 'horizontal'],
    icon: '—',
    desc: '水平分割线',
    execute: (v) => run(v, insertHorizontalRule),
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
