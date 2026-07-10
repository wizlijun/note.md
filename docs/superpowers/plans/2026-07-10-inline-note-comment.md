# 行内批注（note/comment）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 md 编辑中提供 CriticMarkup 行内批注：rich 模式角标 + hover 预览 + 点击编辑，source 模式原样文本标记，导出/分享默认保留批注。

**Architecture:** moraya-core 增加 `annotation` mark（包裹批注，note 存 attr）和 `note_anchor` inline atom 节点（插入点批注），markdown-it inline rule 解析 CriticMarkup、序列化器原样输出。mdeditor 只做 UI：角标 widget 插件、hover/编辑气泡、右键/快捷键/Slash 三入口、source 文本包裹、marked 导出扩展。

**Tech Stack:** TypeScript, ProseMirror (prosemirror-markdown/markdown-it), Svelte 5 runes, marked, vitest。

**Spec:** `docs/superpowers/specs/2026-07-10-inline-note-comment-design.md`

**两个仓库:** Task 1–4 在 `/Users/bruce/git/moraya-core`（独立 git 仓库，单独 commit）；Task 5–13 在 `/Users/bruce/git/mdeditor`。**Task 4（构建+sync）必须在 Task 7 之前完成**，否则 mdeditor 测试拿不到新 schema。

**语法约定（贯穿所有任务）:**

```
包裹批注：  {==被标注文字==}{>>批注内容<<}    两段必须紧邻
插入点批注：{>>批注内容<<}
```

批注内容为单行纯文本；残缺标记不解析（fail open）。注意：单独的 `{==x==}`（无紧邻批注段）会被现有 `==` highlight 规则解析成 `{` + highlight + `}`，round-trip 仍无损，属预期行为。

---

## Task 1: moraya-core — schema：annotation mark + note_anchor 节点

**Files:**
- Modify: `/Users/bruce/git/moraya-core/src/schema.ts`
- Test: `/Users/bruce/git/moraya-core/src/__tests__/annotation.spec.ts`（新建）

- [ ] **Step 1.1: 写失败的 schema 测试**

新建 `/Users/bruce/git/moraya-core/src/__tests__/annotation.spec.ts`：

```ts
import { describe, test, expect } from 'vitest'
import { createSchema } from '../schema'
import { BrowserMediaResolver } from '../adapters/browser-media-resolver'

const schema = createSchema({ mediaResolver: new BrowserMediaResolver() })

describe('annotation mark — schema', () => {
  test('schema exposes annotation mark type', () => {
    expect(schema.marks.annotation).toBeDefined()
  })

  test('annotation mark is not inclusive (typing after it stays plain)', () => {
    expect(schema.marks.annotation.spec.inclusive).toBe(false)
  })

  test('annotation toDOM carries data-note', () => {
    const dom = schema.marks.annotation.spec.toDOM!(
      schema.marks.annotation.create({ note: 'hi' }), true)
    expect(Array.isArray(dom)).toBe(true)
    expect((dom as unknown[])[1]).toMatchObject({ 'data-note': 'hi' })
  })
})

describe('note_anchor node — schema', () => {
  test('schema exposes note_anchor node type', () => {
    expect(schema.nodes.note_anchor).toBeDefined()
  })

  test('note_anchor is an inline atom', () => {
    const spec = schema.nodes.note_anchor.spec
    expect(spec.inline).toBe(true)
    expect(spec.atom).toBe(true)
  })

  test('note_anchor toDOM carries data-note', () => {
    const dom = schema.nodes.note_anchor.spec.toDOM!(
      schema.nodes.note_anchor.create({ note: 'p' }))
    expect((dom as unknown[])[1]).toMatchObject({ 'data-note': 'p' })
  })
})
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `cd /Users/bruce/git/moraya-core && npx vitest run src/__tests__/annotation.spec.ts`
Expected: FAIL — `schema.marks.annotation` undefined。

- [ ] **Step 1.3: 实现 schema**

在 `/Users/bruce/git/moraya-core/src/schema.ts` 中：

(a) 在 `math_inline` NodeSpec（581 行附近）之前加：

```ts
// ── CriticMarkup point annotation: {>>note<<} ───────────────────
// An inline atom carrying the note text in an attr — the note never
// enters the document text flow, so hiding/editing it is trivial.
const note_anchor: NodeSpec = {
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: { note: { default: '' } },
  parseDOM: [{
    tag: 'span[data-note-anchor]',
    getAttrs(dom: HTMLElement) { return { note: dom.dataset.note ?? '' } },
  }],
  toDOM(node) {
    return ['span', {
      'data-note-anchor': '',
      'data-note': node.attrs.note as string,
      class: 'moraya-note-anchor',
      contenteditable: 'false',
    }]
  },
}
```

(b) 在 `buildNodes` 返回对象（960 行附近，`defListDescription,` 之后）加一行 `note_anchor,`。

(c) 在 `highlight` MarkSpec（750 行附近）之后加：

```ts
// ── CriticMarkup wrapped annotation: {==text==}{>>note<<} ──────
// The note lives in the mark attr; serializer re-emits CriticMarkup.
const annotation: MarkSpec = {
  attrs: { note: { default: '' } },
  inclusive: false,
  parseDOM: [{
    tag: 'span[data-annotation]',
    getAttrs(dom: HTMLElement) { return { note: dom.dataset.note ?? '' } },
  }],
  toDOM(mark) {
    return ['span', {
      'data-annotation': '',
      'data-note': mark.attrs.note as string,
      class: 'moraya-annotation',
    }, 0]
  },
}
```

(d) 在 `marks` record（973 行附近）加 `annotation,`（`highlight,` 之后）。

注意：schema.ts 头部注释 `Marks (7): …` 计数更新为 8 并追加 `annotation`。

- [ ] **Step 1.4: 跑测试确认通过**

Run: `cd /Users/bruce/git/moraya-core && npx vitest run src/__tests__/annotation.spec.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 1.5: Commit（moraya-core 仓库）**

```bash
cd /Users/bruce/git/moraya-core
git add src/schema.ts src/__tests__/annotation.spec.ts
git commit -m "feat(schema): annotation mark + note_anchor node for CriticMarkup notes"
```

---

## Task 2: moraya-core — 解析：markdown-it inline rule + parserTokens

**Files:**
- Modify: `/Users/bruce/git/moraya-core/src/markdown.ts`
- Test: `/Users/bruce/git/moraya-core/src/__tests__/annotation.spec.ts`

- [ ] **Step 2.1: 写失败的解析测试**

在 `annotation.spec.ts` 追加（顶部补 `import { parseMarkdown, serializeMarkdown } from '../markdown'`；serializeMarkdown 供 Task 3 使用）：

```ts
describe('CriticMarkup — parsing', () => {
  test('{==text==}{>>note<<} parses to annotation mark', () => {
    const doc = parseMarkdown('a {==bc==}{>>my note<<} d\n')
    let note = ''
    let marked = ''
    doc.descendants((node) => {
      const m = node.marks.find((mk) => mk.type.name === 'annotation')
      if (node.isText && m) { note = m.attrs.note as string; marked = node.text || '' }
    })
    expect(marked).toBe('bc')
    expect(note).toBe('my note')
  })

  test('standalone {>>note<<} parses to note_anchor node', () => {
    const doc = parseMarkdown('end{>>point note<<}\n')
    let found: string | null = null
    doc.descendants((node) => {
      if (node.type.name === 'note_anchor') found = node.attrs.note as string
    })
    expect(found).toBe('point note')
  })

  test('inline formatting survives inside annotated text', () => {
    const doc = parseMarkdown('{==has **bold** word==}{>>n<<}\n')
    let boldAnnotated = false
    doc.descendants((node) => {
      if (node.isText && node.text === 'bold'
          && node.marks.some((m) => m.type.name === 'strong')
          && node.marks.some((m) => m.type.name === 'annotation')) boldAnnotated = true
    })
    expect(boldAnnotated).toBe(true)
  })

  test('unclosed marker stays literal text (fail open)', () => {
    const doc = parseMarkdown('a {>>never closed\n')
    let hasAnchor = false
    doc.descendants((node) => { if (node.type.name === 'note_anchor') hasAnchor = true })
    expect(hasAnchor).toBe(false)
    expect(doc.textContent).toContain('{>>never closed')
  })

  test('empty note is allowed: {>><<}', () => {
    const doc = parseMarkdown('x{>><<}\n')
    let found: string | null = null
    doc.descendants((node) => {
      if (node.type.name === 'note_anchor') found = node.attrs.note as string
    })
    expect(found).toBe('')
  })
})
```

- [ ] **Step 2.2: 跑测试确认失败**

Run: `cd /Users/bruce/git/moraya-core && npx vitest run src/__tests__/annotation.spec.ts`
Expected: parsing 5 例 FAIL（annotation mark / note_anchor 未产出）。

- [ ] **Step 2.3: 实现 inline rule 与 token 映射**

在 `/Users/bruce/git/moraya-core/src/markdown.ts`：

(a) 紧跟 caret_highlight 规则（71 行 `})` 之后）加：

```ts
// ── CriticMarkup annotation rules ───────────────────────────────
// {==text==}{>>note<<} → critic_anno_open / inline content / critic_anno_close
// {>>note<<}           → critic_note (self-closing, nesting 0)
// Registered as a plain push: markdown-it's text rule already breaks on `{`,
// and the inner `==…==` never reaches markdown-it-mark because we tokenize
// the slice between the delimiters directly.
md.inline.ruler.push('critic_annotation', (state, silent) => {
  const src = state.src
  const start = state.pos
  if (src.charCodeAt(start) !== 0x7B /* { */) return false

  // Standalone point annotation: {>>note<<}
  if (src.startsWith('{>>', start)) {
    const close = src.indexOf('<<}', start + 3)
    if (close < 0) return false
    const note = src.slice(start + 3, close)
    if (note.includes('\n')) return false
    if (!silent) {
      const tok = state.push('critic_note', '', 0)
      tok.meta = { note }
    }
    state.pos = close + 3
    return true
  }

  // Wrapped annotation: {==text==}{>>note<<} (segments must be adjacent)
  if (!src.startsWith('{==', start)) return false
  const hlClose = src.indexOf('==}{>>', start + 3)
  if (hlClose < 0) return false
  const text = src.slice(start + 3, hlClose)
  if (!text || text.includes('\n')) return false
  const noteStart = hlClose + 6
  const noteClose = src.indexOf('<<}', noteStart)
  if (noteClose < 0) return false
  const note = src.slice(noteStart, noteClose)
  if (note.includes('\n')) return false

  if (!silent) {
    const open = state.push('critic_anno_open', 'span', 1)
    open.meta = { note }
    // Recursively tokenize the wrapped text so **bold** etc. still work.
    const oldPos = state.pos
    const oldMax = state.posMax
    state.pos = start + 3
    state.posMax = hlClose
    state.md.inline.tokenize(state)
    state.pos = oldPos
    state.posMax = oldMax
    state.push('critic_anno_close', 'span', -1)
  }
  state.pos = noteClose + 3
  return true
})
```

(b) 在 `parserTokens` 的 mark 段（419 行 `caret_highlight: …` 之后）加：

```ts
  critic_anno: {
    mark: 'annotation',
    getAttrs: (tok) => ({ note: ((tok.meta as { note?: string } | null)?.note) ?? '' }),
  },
  critic_note: {
    node: 'note_anchor',
    getAttrs: (tok) => ({ note: ((tok.meta as { note?: string } | null)?.note) ?? '' }),
  },
```

- [ ] **Step 2.4: 跑测试确认通过**

Run: `cd /Users/bruce/git/moraya-core && npx vitest run src/__tests__/annotation.spec.ts`
Expected: PASS。同时跑全量确认无回归：`npm test`（重点看 highlight.spec / roundtrip.spec 不受影响）。

- [ ] **Step 2.5: Commit（moraya-core 仓库）**

```bash
cd /Users/bruce/git/moraya-core
git add src/markdown.ts src/__tests__/annotation.spec.ts
git commit -m "feat(markdown): parse CriticMarkup {==text==}{>>note<<} / {>>note<<}"
```

---

## Task 3: moraya-core — 序列化 + round-trip

**Files:**
- Modify: `/Users/bruce/git/moraya-core/src/markdown.ts`
- Test: `/Users/bruce/git/moraya-core/src/__tests__/annotation.spec.ts`

- [ ] **Step 3.1: 写失败的序列化测试**

在 `annotation.spec.ts` 追加：

```ts
describe('CriticMarkup — serialization / round-trip', () => {
  test('wrapped annotation round-trips exactly', () => {
    const md = 'a {==bc==}{>>my note<<} d\n'
    expect(serializeMarkdown(parseMarkdown(md))).toBe(md)
  })

  test('point annotation round-trips exactly', () => {
    const md = 'end{>>point note<<}\n'
    expect(serializeMarkdown(parseMarkdown(md))).toBe(md)
  })

  test('inline bold inside annotation round-trips', () => {
    const md = '{==has **bold** word==}{>>n<<}\n'
    expect(serializeMarkdown(parseMarkdown(md))).toBe(md)
  })

  test('note text is sanitized on serialize (newline / <<} guard)', () => {
    const doc = parseMarkdown('x{>>ok<<}\n')
    let anchorType: import('prosemirror-model').NodeType | null = null
    doc.descendants((n) => { if (n.type.name === 'note_anchor') anchorType = n.type })
    expect(anchorType).not.toBeNull()
    // Build a doc with a hostile note via the node API and serialize it.
    const schema = anchorType!.schema
    const hostile = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text('x'),
        schema.nodes.note_anchor.create({ note: 'line1\nline2 <<} end' }),
      ]),
    ])
    const out = serializeMarkdown(hostile)
    expect(out).toContain('{>>line1 line2 < <} end<<}')
  })
})
```

- [ ] **Step 3.2: 跑测试确认失败**

Run: `cd /Users/bruce/git/moraya-core && npx vitest run src/__tests__/annotation.spec.ts`
Expected: round-trip 用例 FAIL（"Token type \`note_anchor\` not supported" 或序列化丢失标记）。

- [ ] **Step 3.3: 实现序列化**

在 `/Users/bruce/git/moraya-core/src/markdown.ts`：

(a) 在 `isPlainURL`（963 行附近）之前加：

```ts
/**
 * Clean a note string so it cannot break out of its CriticMarkup container:
 * newlines would end the inline run, and a literal `<<}` would close it early.
 */
function sanitizeNote(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/<<\}/g, '< <}')
}
```

(b) serializer 的 nodes 表（`html_inline` 条目，774 行附近之后）加：

```ts
    note_anchor(state, node) {
      state.write(`{>>${sanitizeNote(node.attrs.note as string)}<<}`)
    },
```

(c) serializer 的 marks 表（`highlight` 条目，901 行附近之后）加：

```ts
    annotation: {
      open: '{==',
      close(_state: MarkdownSerializerState, mark: Mark) {
        return `==}{>>${sanitizeNote(mark.attrs.note as string)}<<}`
      },
      mixable: false,
      expelEnclosingWhitespace: true,
    },
```

- [ ] **Step 3.4: 跑测试确认通过 + 全量**

Run: `cd /Users/bruce/git/moraya-core && npx vitest run src/__tests__/annotation.spec.ts && npm test`
Expected: 全部 PASS。

- [ ] **Step 3.5: Commit（moraya-core 仓库）**

```bash
cd /Users/bruce/git/moraya-core
git add src/markdown.ts src/__tests__/annotation.spec.ts
git commit -m "feat(markdown): serialize annotation mark / note_anchor back to CriticMarkup"
```

---

## Task 4: moraya-core — 构建并同步进 mdeditor

**Files:** 无源码改动；产物同步。

- [ ] **Step 4.1: 构建 core**

Run: `cd /Users/bruce/git/moraya-core && npm run build`
Expected: tsup 成功产出 `dist/`。

- [ ] **Step 4.2: 同步进 mdeditor（含 Vite deps 缓存清理）**

Run: `cd /Users/bruce/git/mdeditor && pnpm sync:core`
Expected: 输出 `synced+vite-cache-cleared …`。

- [ ] **Step 4.3: 验证 mdeditor 能看到新 schema**

Run: `cd /Users/bruce/git/mdeditor && node -e "const m=require('@moraya/core');const d=m.parseMarkdown('x{>>hi<<}\n');console.log(m.serializeMarkdown(d))"`

若 @moraya/core 是纯 ESM 导致 require 失败，改用：
`node --input-type=module -e "import('@moraya/core').then(m=>{const d=m.parseMarkdown('x{>>hi<<}\n');console.log(m.serializeMarkdown(d))})"`
Expected: 输出 `x{>>hi<<}`。

---

## Task 5: mdeditor — i18n 键（en / zh / ja）

**Files:**
- Modify: `src/lib/i18n/en.ts`（`'ctxmenu.…'` 组附近，515 行起；`'slash.…'` 组附近，132 行起）
- Modify: `src/lib/i18n/zh.ts`、`src/lib/i18n/ja.ts`（两者都是 `Record<keyof Messages, string>` 全量表，缺键会编译报错）

- [ ] **Step 5.1: 添加键**

en.ts（ctxmenu 组末尾 + slash 组末尾附近，各就近插入）：

```ts
  'ctxmenu.note': 'Note',
  'slash.note.label': 'Insert note…',
  'slash.note.desc': 'Annotate with a note/comment',
  'noteedit.placeholder': 'Write a note…',
  'noteedit.delete': 'Delete note',
```

zh.ts（对应位置）：

```ts
  'ctxmenu.note': '批注',
  'slash.note.label': '插入批注…',
  'slash.note.desc': '为所选内容添加批注/注释',
  'noteedit.placeholder': '输入批注…',
  'noteedit.delete': '删除批注',
```

ja.ts（对应位置）：

```ts
  'ctxmenu.note': '注釈',
  'slash.note.label': '注釈を挿入…',
  'slash.note.desc': '選択範囲に注釈/コメントを付ける',
  'noteedit.placeholder': '注釈を入力…',
  'noteedit.delete': '注釈を削除',
```

- [ ] **Step 5.2: 类型检查确认通过**

Run: `cd /Users/bruce/git/mdeditor && pnpm check`
Expected: 0 errors（zh/ja 缺键会在这里暴露）。

- [ ] **Step 5.3: Commit**

```bash
cd /Users/bruce/git/mdeditor
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts
git commit -m "feat(i18n): note/comment annotation strings (en/zh/ja)"
```

---

## Task 6: mdeditor — source 插入纯函数

**Files:**
- Modify: `src/lib/context-menu/text-format.ts`
- Test: `src/lib/context-menu/text-format.test.ts`

- [ ] **Step 6.1: 写失败的测试**

在 `text-format.test.ts` 追加（顶部 import 加 `insertNoteMarkup`）：

```ts
describe('insertNoteMarkup', () => {
  it('wraps a selection and puts the caret inside the note', () => {
    const r = insertNoteMarkup('hello world', 6, 11)
    expect(r.value).toBe('hello {==world==}{>><<}')
    expect(r.selStart).toBe(r.value.length - 3)
    expect(r.selEnd).toBe(r.selStart)
  })

  it('inserts a bare point annotation on a collapsed selection', () => {
    const r = insertNoteMarkup('hello', 5, 5)
    expect(r.value).toBe('hello{>><<}')
    expect(r.selStart).toBe('hello{>>'.length)
    expect(r.selEnd).toBe(r.selStart)
  })

  it('inserts mid-text without touching surroundings', () => {
    const r = insertNoteMarkup('abcd', 2, 2)
    expect(r.value).toBe('ab{>><<}cd')
    expect(r.selStart).toBe('ab{>>'.length)
  })
})
```

- [ ] **Step 6.2: 跑测试确认失败**

Run: `cd /Users/bruce/git/mdeditor && npx vitest run src/lib/context-menu/text-format.test.ts`
Expected: FAIL — `insertNoteMarkup` 未导出。

- [ ] **Step 6.3: 实现**

在 `text-format.ts` 末尾（`expandToWord` 之后）加：

```ts
/**
 * Insert a CriticMarkup annotation at [start,end): wraps a non-empty selection
 * as `{==sel==}{>><<}`, or inserts a bare `{>><<}` on a collapsed selection.
 * The caret lands between `>>` and `<<` so the user can type the note directly.
 */
export function insertNoteMarkup(value: string, start: number, end: number): WrapResult {
  const sel = value.slice(start, end)
  const insert = sel ? `{==${sel}==}{>><<}` : '{>><<}'
  const caret = start + insert.length - 3
  return {
    value: value.slice(0, start) + insert + value.slice(end),
    selStart: caret,
    selEnd: caret,
  }
}
```

- [ ] **Step 6.4: 跑测试确认通过**

Run: `npx vitest run src/lib/context-menu/text-format.test.ts`
Expected: PASS。

- [ ] **Step 6.5: Commit**

```bash
git add src/lib/context-menu/text-format.ts src/lib/context-menu/text-format.test.ts
git commit -m "feat(note): insertNoteMarkup source-mode text helper"
```

---

## Task 7: mdeditor — note-anno 核心模块（state / commands / badge 插件）

**Files:**
- Create: `src/lib/note-anno/note-ui.svelte.ts`
- Create: `src/lib/note-anno/note-commands.ts`
- Create: `src/lib/note-anno/note-plugin.ts`
- Test: `src/lib/note-anno/note-commands.test.ts`

依赖：Task 4 已把新版 @moraya/core 同步进 node_modules。

- [ ] **Step 7.1: 写失败的测试**

新建 `src/lib/note-anno/note-commands.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { parseMarkdown } from '@moraya/core'
import { sanitizeNote, findAnnotationRange } from './note-commands'

describe('sanitizeNote', () => {
  it('flattens newlines and defuses <<}', () => {
    expect(sanitizeNote('a\nb\r\nc')).toBe('a b c')
    expect(sanitizeNote('x <<} y')).toBe('x < <} y')
  })
})

describe('findAnnotationRange', () => {
  // doc: paragraph("a", annotated("bc", note "n"), "d") → positions:
  // a=1..2, bc=2..4, d=4..5
  const doc = parseMarkdown('a{==bc==}{>>n<<}d\n')

  it('finds the range from a position inside the mark', () => {
    expect(findAnnotationRange(doc, 3)).toEqual({ from: 2, to: 4, note: 'n' })
  })

  it('finds the range at its end boundary', () => {
    expect(findAnnotationRange(doc, 4)).toEqual({ from: 2, to: 4, note: 'n' })
  })

  it('returns null outside any annotation', () => {
    expect(findAnnotationRange(doc, 1)).toBeNull()
  })

  it('spans split text nodes (bold inside annotation)', () => {
    const d2 = parseMarkdown('{==x **y** z==}{>>m<<}\n')
    const r = findAnnotationRange(d2, 3)
    expect(r?.note).toBe('m')
    expect(r?.from).toBe(1)
    expect(r?.to).toBe(1 + 'x y z'.length)
  })
})
```

- [ ] **Step 7.2: 跑测试确认失败**

Run: `npx vitest run src/lib/note-anno/note-commands.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 7.3: 实现 note-ui.svelte.ts**

```ts
// Shared UI state for annotation popovers. Rich mode writes it from DOM
// event handlers; NotePopover / NoteEditPopup render from it.

export interface NoteEditState {
  x: number
  y: number
  note: string
  save: (note: string) => void
  remove: () => void
}

export interface NoteHoverState {
  x: number
  y: number
  note: string
}

export const noteUi = $state({
  edit: null as NoteEditState | null,
  hover: null as NoteHoverState | null,
})
```

- [ ] **Step 7.4: 实现 note-commands.ts**

```ts
import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { noteUi } from './note-ui.svelte'

/**
 * Clean a note string so it cannot break out of its CriticMarkup container:
 * newlines end the inline run, a literal `<<}` would close it early.
 * (moraya-core sanitizes again on serialize — this keeps the doc clean too.)
 */
export function sanitizeNote(s: string): string {
  return s.replace(/\r?\n/g, ' ').replace(/<<\}/g, '< <}')
}

/**
 * Find the contiguous inline range carrying the annotation mark that spans
 * `pos` (inclusive of both boundaries). Adjacent runs with different note
 * texts are treated as separate annotations.
 */
export function findAnnotationRange(
  doc: PMNode, pos: number,
): { from: number; to: number; note: string } | null {
  const $pos = doc.resolve(pos)
  const parent = $pos.parent
  if (!parent.isTextblock) return null
  const base = $pos.start()
  let runStart = -1
  let runEnd = -1
  let runNote = ''
  let result: { from: number; to: number; note: string } | null = null
  const flush = () => {
    if (!result && runStart >= 0 && pos >= runStart && pos <= runEnd) {
      result = { from: runStart, to: runEnd, note: runNote }
    }
    runStart = -1
  }
  parent.forEach((child, offset) => {
    const mark = child.marks.find((m) => m.type.name === 'annotation')
    if (mark) {
      const note = mark.attrs.note as string
      if (runStart < 0 || note !== runNote) { flush(); runStart = base + offset; runNote = note }
      runEnd = base + offset + child.nodeSize
    } else {
      flush()
    }
  })
  flush()
  return result
}

/** Open the edit bubble for the wrapped annotation containing `pos`. */
export function openEditForMark(view: EditorView, pos: number, anchor: DOMRect) {
  const range = findAnnotationRange(view.state.doc, pos)
  if (!range) return
  noteUi.hover = null
  noteUi.edit = {
    x: anchor.left,
    y: anchor.bottom + 4,
    note: range.note,
    save(next) {
      const r = findAnnotationRange(view.state.doc, pos)
      if (!r) return
      const type = view.state.schema.marks.annotation
      const clean = sanitizeNote(next)
      if (clean === r.note) return
      view.dispatch(
        view.state.tr
          .removeMark(r.from, r.to, type)
          .addMark(r.from, r.to, type.create({ note: clean })),
      )
    },
    remove() {
      const r = findAnnotationRange(view.state.doc, pos)
      if (!r) return
      view.dispatch(view.state.tr.removeMark(r.from, r.to, view.state.schema.marks.annotation))
    },
  }
}

/** Open the edit bubble for the note_anchor node at `pos`. */
export function openEditForAnchor(view: EditorView, pos: number, anchor: DOMRect) {
  const node = view.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'note_anchor') return
  noteUi.hover = null
  noteUi.edit = {
    x: anchor.left,
    y: anchor.bottom + 4,
    note: node.attrs.note as string,
    save(next) {
      const n = view.state.doc.nodeAt(pos)
      if (!n || n.type.name !== 'note_anchor') return
      const clean = sanitizeNote(next)
      if (clean === n.attrs.note) return
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { note: clean }))
    },
    remove() {
      const n = view.state.doc.nodeAt(pos)
      if (!n || n.type.name !== 'note_anchor') return
      view.dispatch(view.state.tr.delete(pos, pos + n.nodeSize))
    },
  }
}

/**
 * Insert-annotation command (rich mode): wraps a non-empty selection with the
 * annotation mark, or inserts a note_anchor at the caret; then opens the edit
 * bubble so the user can type the note immediately.
 */
export function insertNoteRich(view: EditorView) {
  const { state } = view
  const { from, to, empty } = state.selection
  const coords = view.coordsAtPos(to)
  const rect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top)
  if (empty) {
    const type = state.schema.nodes.note_anchor
    if (!type) return
    view.dispatch(state.tr.replaceSelectionWith(type.create({ note: '' })))
    openEditForAnchor(view, from, rect)
  } else {
    const type = state.schema.marks.annotation
    if (!type) return
    view.dispatch(state.tr.addMark(from, to, type.create({ note: '' })))
    openEditForMark(view, from + 1, rect)
  }
  view.focus()
}
```

- [ ] **Step 7.5: 实现 note-plugin.ts（角标 widget decoration）**

```ts
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'

const noteBadgeKey = new PluginKey<DecorationSet>('note-badges')

/**
 * Append a badge widget after each contiguous annotation-mark range.
 * note_anchor nodes render their own badge via toDOM, so they're skipped.
 */
function buildBadges(doc: PMNode): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'annotation')
    if (!mark) return
    const end = pos + node.nodeSize
    // Badge only the last node of the run: skip if the next inline node
    // continues the same annotation.
    const $end = doc.resolve(end)
    const after = $end.nodeAfter
    if (after && mark.isInSet(after.marks)) return
    const note = mark.attrs.note as string
    decos.push(
      Decoration.widget(end, () => {
        const el = document.createElement('span')
        el.className = 'note-badge'
        el.dataset.note = note
        el.contentEditable = 'false'
        return el
      }, { side: 1, key: `note-badge-${end}-${note}` }),
    )
  })
  return DecorationSet.create(doc, decos)
}

export function noteBadgePlugin(): Plugin<DecorationSet> {
  return new Plugin({
    key: noteBadgeKey,
    state: {
      init: (_config, { doc }) => buildBadges(doc),
      apply: (tr, old) => (tr.docChanged ? buildBadges(tr.doc) : old),
    },
    props: {
      decorations(state) { return noteBadgeKey.getState(state) },
    },
  })
}
```

- [ ] **Step 7.6: 跑测试确认通过**

Run: `npx vitest run src/lib/note-anno/note-commands.test.ts`
Expected: PASS（6 用例）。

- [ ] **Step 7.7: Commit**

```bash
git add src/lib/note-anno/
git commit -m "feat(note): note-anno core — ui state, PM commands, badge plugin"
```

---

## Task 8: mdeditor — 气泡组件 + 编辑器 CSS

**Files:**
- Create: `src/lib/note-anno/NotePopover.svelte`
- Create: `src/lib/note-anno/NoteEditPopup.svelte`
- Modify: `src/styles/editor-base.css`

- [ ] **Step 8.1: NotePopover.svelte（hover 预览）**

```svelte
<script lang="ts">
  import { noteUi } from './note-ui.svelte'
</script>

{#if noteUi.hover && !noteUi.edit}
  <div class="note-popover" style="left:{noteUi.hover.x}px; top:{noteUi.hover.y}px">
    {noteUi.hover.note}
  </div>
{/if}

<style>
  .note-popover {
    position: fixed;
    z-index: 1000;
    max-width: 320px;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--bg, #fffbe8);
    color: var(--fg, #3b3b3b);
    border: 1px solid rgba(0, 0, 0, 0.12);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
    pointer-events: none;
  }
  @media (prefers-color-scheme: dark) {
    .note-popover {
      background: #3a3520;
      color: #e8e2c8;
      border-color: rgba(255, 255, 255, 0.14);
    }
  }
</style>
```

- [ ] **Step 8.2: NoteEditPopup.svelte（点击编辑气泡）**

组件由父级条件挂载（`{#if noteUi.edit}`），挂载即打开。关闭（点外部 / Esc）即保存；删除按钮移除批注。

```svelte
<script lang="ts">
  import { noteUi } from './note-ui.svelte'
  import { t } from '../i18n/store.svelte'

  // Captured at mount: the parent only mounts this while noteUi.edit is set.
  const editState = noteUi.edit!
  let text = $state(editState.note)
  let root: HTMLDivElement | undefined = $state()
  let ta: HTMLTextAreaElement | undefined = $state()

  $effect(() => { ta?.focus(); ta?.select() })

  function close(save: boolean) {
    if (noteUi.edit !== editState) return
    noteUi.edit = null
    if (save) editState.save(text)
  }
  function onDelete() {
    if (noteUi.edit !== editState) return
    noteUi.edit = null
    editState.remove()
  }
  function onWindowMousedown(e: MouseEvent) {
    if (root && !root.contains(e.target as Node)) close(true)
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); close(true) }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); close(true) }
  }
</script>

<svelte:window onmousedown={onWindowMousedown} />

<div
  class="note-edit"
  bind:this={root}
  style="left:{editState.x}px; top:{editState.y}px"
  onkeydown={onKeydown}
  role="dialog"
  aria-label={t('ctxmenu.note')}
  tabindex="-1"
>
  <textarea
    bind:this={ta}
    bind:value={text}
    rows="3"
    placeholder={t('noteedit.placeholder')}
  ></textarea>
  <div class="row">
    <button class="del" onclick={onDelete}>{t('noteedit.delete')}</button>
  </div>
</div>

<style>
  .note-edit {
    position: fixed;
    z-index: 1001;
    width: 280px;
    padding: 8px;
    border-radius: 8px;
    background: var(--menu-bg, #fff);
    border: 1px solid rgba(0, 0, 0, 0.15);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font: inherit;
    font-size: 13px;
    border: 1px solid rgba(0, 0, 0, 0.15);
    border-radius: 5px;
    padding: 5px 7px;
    outline: none;
  }
  .row { display: flex; justify-content: flex-end; margin-top: 6px; }
  .del {
    font-size: 12px;
    color: #c0392b;
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .del:hover { background: rgba(192, 57, 43, 0.1); }
  @media (prefers-color-scheme: dark) {
    .note-edit { background: #2a2a2e; border-color: rgba(255, 255, 255, 0.15); }
    textarea { background: #1e1e22; color: #ddd; border-color: rgba(255, 255, 255, 0.15); }
  }
</style>
```

- [ ] **Step 8.3: editor-base.css 追加批注样式**

在 `src/styles/editor-base.css` 的 wikilink 规则（22–31 行附近）之后加：

```css
/* ── Inline annotations (CriticMarkup notes) ─────────────────── */
.moraya-editor .moraya-annotation {
  background: rgba(255, 213, 79, 0.28);
  border-bottom: 1px dashed #d9a400;
}
.moraya-editor .note-badge,
.moraya-editor .moraya-note-anchor {
  display: inline-block;
  cursor: pointer;
  user-select: none;
  color: #b8860b;
  font-size: 0.72em;
  vertical-align: super;
  line-height: 1;
  margin: 0 1px;
}
.moraya-editor .note-badge::before,
.moraya-editor .moraya-note-anchor::before {
  content: '※';
}
.moraya-editor .note-badge:hover,
.moraya-editor .moraya-note-anchor:hover {
  color: #8a6508;
}
@media (prefers-color-scheme: dark) {
  .moraya-editor .moraya-annotation {
    background: rgba(217, 164, 0, 0.24);
    border-bottom-color: #e3b341;
  }
  .moraya-editor .note-badge,
  .moraya-editor .moraya-note-anchor { color: #e3b341; }
  .moraya-editor .note-badge:hover,
  .moraya-editor .moraya-note-anchor:hover { color: #f5cd60; }
}
```

- [ ] **Step 8.4: 检查通过**

Run: `pnpm check`
Expected: 0 errors。

- [ ] **Step 8.5: Commit**

```bash
git add src/lib/note-anno/NotePopover.svelte src/lib/note-anno/NoteEditPopup.svelte src/styles/editor-base.css
git commit -m "feat(note): hover popover + edit popup components, editor annotation styles"
```

---

## Task 9: mdeditor — RichEditor 接线 + Slash 菜单项

**Files:**
- Modify: `src/components/RichEditor.svelte`
- Modify: `src/lib/slash-menu/slash-items.ts`

- [ ] **Step 9.1: 注入 badge 插件**

`RichEditor.svelte` 中 wikilink 插件注入处（874–882 行 try 块内），将 reconfigure 改为同时挂两个插件：

```ts
        try {
          const view = inst.view as unknown as EditorView
          const { wikilinkPlugin } = await import('../lib/wikilink-plugin')
          const { noteBadgePlugin } = await import('../lib/note-anno/note-plugin')
          view.updateState(
            view.state.reconfigure({
              plugins: view.state.plugins.concat(wikilinkPlugin(), noteBadgePlugin()),
            }),
          )
        } catch (e) {
          console.warn('[RichEditor] wikilink plugin init failed:', e)
        }
```

- [ ] **Step 9.2: 点击/hover 事件处理**

`<script>` 中（`handleImageClick` 附近）加两个 handler；import 区加：

```ts
  import { noteUi } from '../lib/note-anno/note-ui.svelte'
  import { openEditForMark, openEditForAnchor, insertNoteRich } from '../lib/note-anno/note-commands'
  import NotePopover from '../lib/note-anno/NotePopover.svelte'
  import NoteEditPopup from '../lib/note-anno/NoteEditPopup.svelte'
```

```ts
  /** Click on a note badge (annotation widget or note_anchor node) → edit bubble. */
  function handleNoteClick(e: MouseEvent) {
    const target = e.target as HTMLElement
    const badge = target.closest('.note-badge, .moraya-note-anchor') as HTMLElement | null
    if (!badge || !editor) return
    e.preventDefault()
    e.stopPropagation()
    const view = editor.view as unknown as EditorView
    const rect = badge.getBoundingClientRect()
    const pos = view.posAtDOM(badge, 0)
    if (badge.classList.contains('moraya-note-anchor')) {
      // posAtDOM may resolve just inside/after the atom — probe both sides.
      const node = view.state.doc.nodeAt(pos)
      if (node?.type.name === 'note_anchor') openEditForAnchor(view, pos, rect)
      else openEditForAnchor(view, pos - 1, rect)
    } else {
      // Badge widget sits AFTER the annotated range → look left of it.
      openEditForMark(view, pos - 1, rect)
    }
  }

  /** Hover over anything carrying data-note → floating preview. */
  function handleNoteHover(e: MouseEvent) {
    const el = (e.target as HTMLElement).closest('[data-note]') as HTMLElement | null
    if (!el || !el.dataset.note) { noteUi.hover = null; return }
    const rect = el.getBoundingClientRect()
    noteUi.hover = { x: rect.left, y: rect.bottom + 4, note: el.dataset.note }
  }
```

监听注册（884–889 行的 addEventListener 组，capture 与 link 一致）：

```ts
        _pmEl?.addEventListener('click', handleNoteClick as EventListener, true)
        _pmEl?.addEventListener('mouseover', handleNoteHover as EventListener)
```

以及对应的清理处（935 行附近 removeEventListener 组）：

```ts
    _pmEl?.removeEventListener('click', handleNoteClick as EventListener, true)
    _pmEl?.removeEventListener('mouseover', handleNoteHover as EventListener)
```

注意：`handleNoteClick` 的 capture 注册必须在 `handleImageClick` 之前不必须，但 `stopPropagation` 需保证角标点击不再触发链接/图片逻辑（capture=true 已保证先于非 capture 的 click）。

- [ ] **Step 9.3: Cmd+Shift+N 快捷键**

`handleRichKeydown` 中拿到 `mod/shift/key/view` 之后（430 行附近，任务列表快捷键之前）加：

```ts
    // ── Insert annotation: Cmd+Shift+N ──
    if (mod && shift && !alt && key === 'm') {
      event.preventDefault()
      insertNoteRich(view)
      return
    }
```

先确认无冲突：`grep -n "'m'" src/components/RichEditor.svelte` 应无既有 mod+shift+M 绑定。

- [ ] **Step 9.4: 挂载气泡组件**

模板底部（`{#if showSlashMenu}` 块附近，979 行）加：

```svelte
  <NotePopover />
  {#if noteUi.edit}
    <NoteEditPopup />
  {/if}
```

- [ ] **Step 9.5: Slash 菜单项**

`src/lib/slash-menu/slash-items.ts` 的 `getSlashItems()` 返回数组中（`insert-doc` 项之后）加：

```ts
  {
    id: 'insert-note',
    label: t('slash.note.label'),
    keywords: ['note', 'comment', 'annotation', '批注', '注释', '备注'],
    icon: '※',
    desc: t('slash.note.desc'),
    execute: async (v) => {
      const { insertNoteRich } = await import('../note-anno/note-commands')
      insertNoteRich(v)
    },
  },
```

- [ ] **Step 9.6: 检查通过**

Run: `pnpm check && pnpm test`
Expected: 0 errors，全部测试 PASS。

- [ ] **Step 9.7: Commit**

```bash
git add src/components/RichEditor.svelte src/lib/slash-menu/slash-items.ts
git commit -m "feat(note): rich-mode wiring — badge plugin, hover/click popups, Cmd+Shift+N, slash item"
```

---

## Task 10: mdeditor — 右键菜单（model + icons + 双适配器）

**Files:**
- Modify: `src/lib/context-menu/menu-model.ts`
- Modify: `src/lib/context-menu/icons.ts`
- Modify: `src/lib/context-menu/rich-actions.ts`
- Modify: `src/lib/context-menu/source-actions.ts`
- Test: `src/lib/context-menu/menu-model.test.ts`

- [ ] **Step 10.1: 写失败的测试**

在 `menu-model.test.ts` 追加（沿用文件既有的断言风格）：

```ts
it('includes the note item in the emphasis group', () => {
  const groups = getMenuModel({ hasSelection: false })
  const emphasis = groups.find((g) => g.id === 'emphasis')!
  const note = emphasis.items.find((i) => i.id === 'note')
  expect(note).toBeDefined()
  expect(note!.needsSelection).toBeUndefined() // works with or without selection
})
```

- [ ] **Step 10.2: 跑测试确认失败**

Run: `npx vitest run src/lib/context-menu/menu-model.test.ts`
Expected: FAIL — note item 不存在。

- [ ] **Step 10.3: 实现**

(a) `menu-model.ts` 的 emphasis 组（`wikilink` 之后）加：

```ts
      item('note', 'ctxmenu.note', { emphasis: true, icon: 'note' }),
```

(b) `icons.ts` 的 icons 表加（line-SVG 风格，message-square 造型）：

```ts
  note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
```

(c) `rich-actions.ts` 的 `run(id)` switch 中（`case 'wikilink'` 之后）加：

```ts
        case 'note': {
          const { insertNoteRich } = await import('../note-anno/note-commands')
          return insertNoteRich(view)
        }
```

(d) `source-actions.ts`：顶部 import 增加 `insertNoteMarkup`（来自 `./text-format`），`run(id)` switch 中（`case 'wikilink'` 之后）加：

```ts
        case 'note': {
          const start = h.el.selectionStart ?? 0
          const end = h.el.selectionEnd ?? 0
          const r = insertNoteMarkup(h.value(), start, end)
          setContent(h.tabId, r.value)
          requestAnimationFrame(() => { h.el.focus(); h.el.setSelectionRange(r.selStart, r.selEnd) })
          return
        }
```

- [ ] **Step 10.4: 跑测试确认通过**

Run: `npx vitest run src/lib/context-menu/ && pnpm check`
Expected: PASS。

- [ ] **Step 10.5: Commit**

```bash
git add src/lib/context-menu/
git commit -m "feat(note): context-menu note item with rich/source adapters"
```

---

## Task 11: mdeditor — SourceView：快捷键 + 语法着色

**Files:**
- Modify: `src/components/SourceView.svelte`

- [ ] **Step 11.1: Cmd+Shift+N 插入**

`onTextareaKeydown`（69 行起）的 `if (ev.metaKey || ev.ctrlKey)` 块顶部（`let open = ''` 之前）加：

```ts
      // ── Insert annotation: Cmd+Shift+N ──
      if (ev.shiftKey && ev.key.toLowerCase() === 'm' && tabId && textareaEl) {
        ev.preventDefault()
        ev.stopPropagation()
        const el = textareaEl
        const r = insertNoteMarkup(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0)
        setContent(tabId, r.value)
        requestAnimationFrame(() => el.setSelectionRange(r.selStart, r.selEnd))
        return
      }
```

import 处（244 行 `import { applyWrap }`）改为：

```ts
  import { applyWrap, insertNoteMarkup } from '../lib/context-menu/text-format'
```

- [ ] **Step 11.2: highlight() 中给 CriticMarkup 着色**

`highlight(src)`（123 行起）非标题分支中，`let out = escapeHtml(line) || ' '` 之后加（单次替换避免二次包裹；注意文本已 HTML 转义，`>` 变成 `&gt;`、`<` 变成 `&lt;`）：

```ts
      // CriticMarkup annotations: tint {==…==} and {>>…<<} spans.
      out = out.replace(
        /(\{==.+?==\})?(\{&gt;&gt;.*?&lt;&lt;\})/g,
        (_all, hl: string | undefined, note: string) =>
          (hl ? `<span class="crit-hl">${hl}</span>` : '') +
          `<span class="crit-note">${note}</span>`,
      )
```

- [ ] **Step 11.3: 组件样式**

`<style>` 中 `.hl :global(.h)` 规则（625 行附近）之后加：

```css
  .hl :global(.crit-hl) {
    background: rgba(255, 213, 79, 0.28);
    border-radius: 2px;
  }
  .hl :global(.crit-note) {
    color: #b8860b;
    background: rgba(217, 164, 0, 0.12);
    border-radius: 2px;
  }
  @media (prefers-color-scheme: dark) {
    .hl :global(.crit-hl) { background: rgba(217, 164, 0, 0.22); }
    .hl :global(.crit-note) { color: #e3b341; background: rgba(227, 179, 65, 0.12); }
  }
```

- [ ] **Step 11.4: 检查通过**

Run: `pnpm check && pnpm test`
Expected: PASS。

- [ ] **Step 11.5: Commit**

```bash
git add src/components/SourceView.svelte
git commit -m "feat(note): source-mode Cmd+Shift+N insert + CriticMarkup tinting"
```

---

## Task 12: mdeditor — 导出/分享渲染（marked 扩展 + CSS）

**Files:**
- Modify: `src/lib/plugins/host-render-html.ts`
- Modify: `src/lib/print.ts`
- Modify: `src/lib/plugins/share-baker.ts`
- Test: `src/lib/plugins/host-render-html.test.ts`

- [ ] **Step 12.1: 写失败的测试**

在 `host-render-html.test.ts` 追加（沿用文件既有 import；`renderMarkdownInline` 已导出）：

```ts
describe('CriticMarkup annotations in exported HTML', () => {
  it('renders wrapped annotation as mark + badge with title', () => {
    const html = renderMarkdownInline('a {==bc==}{>>my note<<} d')
    expect(html).toContain('<mark class="crit-anno">bc</mark>')
    expect(html).toContain('class="crit-badge" title="my note"')
  })

  it('renders point annotation as badge only', () => {
    const html = renderMarkdownInline('end{>>hi<<}')
    expect(html).not.toContain('crit-anno')
    expect(html).toContain('class="crit-badge" title="hi"')
  })

  it('escapes hostile note text in the title attribute', () => {
    const html = renderMarkdownInline('x{>>a "b" <i> & c<<}')
    expect(html).toContain('title="a &quot;b&quot; &lt;i&gt; &amp; c"')
  })

  it('keeps inline formatting inside the annotated text', () => {
    const html = renderMarkdownInline('{==has **bold**==}{>>n<<}')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('leaves incomplete markers untouched (fail open)', () => {
    const html = renderMarkdownInline('x {>>never closed')
    expect(html).not.toContain('crit-badge')
  })
})
```

- [ ] **Step 12.2: 跑测试确认失败**

Run: `npx vitest run src/lib/plugins/host-render-html.test.ts`
Expected: 新增用例 FAIL。

- [ ] **Step 12.3: 实现 marked 扩展与 CSS**

在 `host-render-html.ts`：

(a) `highlightEqExtension`（80 行附近）之后加：

```ts
// CriticMarkup annotations: {==text==}{>>note<<} and standalone {>>note<<}.
// Must win over highlightEq: its start() points at the `{`, which precedes
// the inner `==`, so the lexer tries this extension first.
const criticAnnotationExtension: TokenizerAndRendererExtension = {
  name: 'criticAnnotation',
  level: 'inline',
  start(src: string) {
    const a = src.indexOf('{==')
    const b = src.indexOf('{>>')
    if (a < 0) return b
    if (b < 0) return a
    return Math.min(a, b)
  },
  tokenizer(src: string) {
    let m = /^\{==([^\n]+?)==\}\{>>([^\n]*?)<<\}/.exec(src)
    if (m) {
      const token = { type: 'criticAnnotation', raw: m[0], note: m[2], tokens: [] } as any
      this.lexer.inline(m[1], token.tokens)
      return token
    }
    m = /^\{>>([^\n]*?)<<\}/.exec(src)
    if (m) return { type: 'criticAnnotation', raw: m[0], note: m[1], tokens: [] } as any
    return undefined
  },
  renderer(token: any) {
    const badge = `<sup class="crit-badge" title="${htmlEscape(String(token.note))}">※</sup>`
    if (!token.tokens?.length) return badge
    return `<mark class="crit-anno">${this.parser.parseInline(token.tokens)}</mark>${badge}`
  },
}
```

(b) `sharedMarked.use({ extensions: […] })` 行（110 行附近）的数组头部加 `criticAnnotationExtension`：

```ts
sharedMarked.use({ extensions: [criticAnnotationExtension, blockCitationExtension, highlightCaretExtension, highlightEqExtension] })
```

(c) 文件末尾附近导出共享 CSS：

```ts
/** Styles for exported/printed CriticMarkup annotations (light + dark). */
export const CRITIC_CSS = `
.crit-anno { background: #fff3bf; border-bottom: 1px dashed #d9a400; padding: 0 1px; }
.crit-badge { color: #b8860b; cursor: help; font-size: 0.75em; margin-left: 1px; user-select: none; }
@media (prefers-color-scheme: dark) {
  .crit-anno { background: #4d3f00; border-bottom-color: #e3b341; color: inherit; }
  .crit-badge { color: #e3b341; }
}
`
```

- [ ] **Step 12.4: 打印与分享模板引入 CSS**

(a) `src/lib/print.ts`：import 行加 `CRITIC_CSS`（从 `./plugins/host-render-html`，该文件已 import 其他符号，就地扩展）；`wrapPrintHtml` 模板中 `<style>${pdfCss}</style>` 之后加一行：

```
<style>${CRITIC_CSS}</style>
```

(b) `src/lib/plugins/share-baker.ts`：import `CRITIC_CSS`（从 `./host-render-html`）；模板 `<style>${themeCss}</style>`（279 行附近）之后加一行：

```
<style>${CRITIC_CSS}</style>
```

- [ ] **Step 12.5: 跑测试确认通过**

Run: `npx vitest run src/lib/plugins/ && pnpm check`
Expected: PASS。

- [ ] **Step 12.6: Commit**

```bash
git add src/lib/plugins/host-render-html.ts src/lib/plugins/host-render-html.test.ts src/lib/print.ts src/lib/plugins/share-baker.ts
git commit -m "feat(note): render CriticMarkup annotations in export/share/print HTML"
```

---

## Task 13: 全量验证 + dev GUI 实机验证

**Files:** 无新改动（发现问题则回到对应任务修）。

- [ ] **Step 13.1: 双仓库全量测试**

Run:
```bash
cd /Users/bruce/git/moraya-core && npm test
cd /Users/bruce/git/mdeditor && pnpm check && pnpm test
```
Expected: 全部 PASS、0 errors。

- [ ] **Step 13.2: dev 实机验证（GUI 改动惯例，参照 reference_dev_gui_verification 记忆）**

启动 dev 构建（日志重定向 /tmp/mdeditor.log），准备一个含批注的测试文件：

```bash
cat > /tmp/note-test.md <<'EOF'
# 批注测试

这段是{==被批注的文字==}{>>记得核实这个数据<<}，后面是正文。

这段话结尾有个插入点批注{>>单独的一条备注<<}。

嵌套格式：{==含 **加粗** 的批注==}{>>格式测试<<}。
EOF
```

验证清单（osascript 驱动 + screencapture 截图佐证）：

1. rich 模式打开 `/tmp/note-test.md`：被批注文字淡黄高亮，尾部有 ※ 角标；插入点批注只显示 ※。
2. hover 角标/高亮文字 → 浮出批注内容预览。
3. 点击角标 → 编辑气泡弹出、textarea 聚焦且内容选中；改文字后点外部 → 关闭；切 source 模式确认 md 文本已更新。
4. 编辑气泡点"删除批注" → 包裹批注去掉标记但正文保留；插入点批注整体消失。
5. rich 模式选中文字按 Cmd+Shift+N → 包裹并弹出气泡；无选区按 → 插入角标并弹气泡。
6. rich 模式右键 → 菜单有"批注"项且可用；输入 `/` → Slash 菜单可搜到"插入批注"。
7. source 模式：CriticMarkup 有淡黄着色；选中文字 Cmd+Shift+N → 得到 `{==选中==}{>><<}` 且光标在批注位；右键菜单"批注"同样生效。
8. 双模式往返切换：批注无损（rich→source→rich）。
9. File → Print（或打印预览）：高亮 + ※ 角标出现在输出中。
10. 深色外观下重复 1–3 步，确认配色可读。

- [ ] **Step 13.3: 验证通过后收尾**

按 feedback_auto_release 记忆：check+test 通过且 GUI 实机验证完成后自动 commit/push/release（release 走独立 worktree 流程，确认 gh 活跃账号为 wizlijun）。moraya-core 仓库的 commits 也要 push。

---

## 已知限制（v1 有意为之）

- PDF 打印中批注内容不可见（无 hover），仅保留高亮与角标；"导出剥离批注"参数留待后续。
- 单独的 `{==x==}`（无批注段）沿用现有 highlight 解析，显示为 `{` + 高亮 + `}`，round-trip 无损。
- 批注内容为单行纯文本，不支持嵌套批注。
