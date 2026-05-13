# Highlight Mark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 mdeditor 中为 `^^text^^` 和 `==text==` 实现文字高亮：rich editor 视觉高亮（`cmd+H` 切换）、source view 快捷键包裹、导出渲染为 `<mark>`。

**Architecture:** 在 `~/git/moraya-core`（fork `wizlijun/moraya-core`）中添加 ProseMirror `highlight` mark、markdown-it 解析规则、序列化器，并在 `~/git/mdeditor` 中添加 marked 渲染扩展和 SourceView 快捷键。moraya-core 开发阶段以 `file:` 路径链接到 mdeditor。

**Tech Stack:** TypeScript · ProseMirror · markdown-it · prosemirror-markdown · marked · Svelte 5 · vitest · tsup · pnpm

---

## 文件清单

### `~/git/moraya-core`（fork）
| 文件 | 操作 |
|------|------|
| `src/schema.ts` | 修改：添加 `highlight` MarkSpec，加入 `marks` 对象 |
| `src/markdown.ts` | 修改：启用 `mark` 插件、添加 `^^` inline rule、token handlers、serializer mark |
| `src/setup.ts` | 修改：添加 `Mod-h` keymap 绑定 |
| `src/commands.ts` | 修改：导出 `toggleHighlight` 命令 |
| `src/index.ts` | 修改：导出 `toggleHighlight` |
| `src/__tests__/highlight.spec.ts` | 新建：highlight 相关单元测试 |
| `src/__tests__/fixtures/11-highlight.md` | 新建：roundtrip 测试 fixture |

### `~/git/mdeditor`（主仓库）
| 文件 | 操作 |
|------|------|
| `package.json` | 修改：`@moraya/core` 依赖改为 `file:../moraya-core` |
| `src/lib/plugins/host-render-html.ts` | 修改：注册 `^^` 和 `==` 的 marked 扩展 |
| `src/lib/plugins/host-render-html.test.ts` | 修改：添加高亮渲染测试 |
| `src/components/SourceView.svelte` | 修改：添加 cmd+H handler、source 视图 `^^`/`==` 语法高亮 |

---

## Task 1：添加 `highlight` MarkSpec（moraya-core/schema.ts）

**Files:**
- Modify: `~/git/moraya-core/src/schema.ts:705-717`（在 `strike_through` 之后插入）
- Modify: `~/git/moraya-core/src/schema.ts:921-928`（marks 对象）
- Test: `~/git/moraya-core/src/__tests__/highlight.spec.ts`

- [ ] **Step 1.1：新建测试文件，写入 failing test**

```typescript
// ~/git/moraya-core/src/__tests__/highlight.spec.ts
import { describe, test, expect } from 'vitest'
import { createSchema } from '../schema'
import { BrowserMediaResolver } from '../adapters/browser-media-resolver'
import { parseMarkdown, serializeMarkdown } from '../markdown'

const schema = createSchema({ mediaResolver: new BrowserMediaResolver() })

describe('highlight mark — schema', () => {
  test('schema exposes highlight mark type', () => {
    expect(schema.marks.highlight).toBeDefined()
  })

  test('highlight mark renders to <mark> DOM element', () => {
    const markType = schema.marks.highlight
    const dom = markType.spec.toDOM!(markType.create(), false)
    expect(Array.isArray(dom) ? dom[0] : dom).toBe('mark')
  })

  test('highlight mark parses from <mark> element', () => {
    expect(schema.marks.highlight.spec.parseDOM).toEqual(
      expect.arrayContaining([expect.objectContaining({ tag: 'mark' })])
    )
  })
})
```

- [ ] **Step 1.2：在 moraya-core 目录运行测试，确认 fail**

```bash
cd ~/git/moraya-core && pnpm test -- --reporter=verbose 2>&1 | grep -E "highlight|FAIL|Error"
```

Expected: `TypeError` 或 `undefined` 相关失败（schema 还没有 highlight mark）

- [ ] **Step 1.3：在 schema.ts 的 `strike_through` 定义后添加 `highlight` MarkSpec**

在 `src/schema.ts` 第 717 行（`}` 结束 `strike_through` 之后，`html_mark` 之前）插入：

```typescript
const highlight: MarkSpec = {
  parseDOM: [{ tag: 'mark' }],
  toDOM() { return ['mark', 0] as const },
}
```

- [ ] **Step 1.4：将 `highlight` 加入 marks 对象**

将 `src/schema.ts` 中的：

```typescript
const marks: Record<string, MarkSpec> = {
  html_mark,
  strong,
  em,
  code,
  link,
  strike_through,
}
```

改为：

```typescript
const marks: Record<string, MarkSpec> = {
  html_mark,
  strong,
  em,
  code,
  link,
  strike_through,
  highlight,
}
```

- [ ] **Step 1.5：更新文件顶部 docstring 中的 Marks 数量**

将第 22 行：
```
 * Marks (6): html_mark, strong, em, code, link, strike_through
```
改为：
```
 * Marks (7): html_mark, strong, em, code, link, strike_through, highlight
```

- [ ] **Step 1.6：运行测试，确认 pass**

```bash
cd ~/git/moraya-core && pnpm test -- --reporter=verbose 2>&1 | grep -E "highlight|PASS|FAIL"
```

Expected: `highlight mark — schema` 下 3 个测试全部 `✓`

- [ ] **Step 1.7：commit**

```bash
cd ~/git/moraya-core
git add src/schema.ts src/__tests__/highlight.spec.ts
git commit -m "feat: add highlight MarkSpec to schema"
```

---

## Task 2：添加 markdown-it 解析支持（moraya-core/markdown.ts）

**Files:**
- Modify: `~/git/moraya-core/src/markdown.ts:38`（`.enable(...)` 行）
- Modify: `~/git/moraya-core/src/markdown.ts:40`（md 实例之后插入 inline rule）
- Modify: `~/git/moraya-core/src/markdown.ts:307-330`（tokenHandlers）
- Test: `~/git/moraya-core/src/__tests__/highlight.spec.ts`

- [ ] **Step 2.1：在 highlight.spec.ts 追加 parsing 测试**

在现有 `describe('highlight mark — schema', ...)` 之后添加：

```typescript
describe('highlight mark — parsing', () => {
  test('^^text^^ parses to highlight mark', () => {
    const doc = parseMarkdown('Hello ^^world^^ end\n')
    let found = false
    doc.descendants((node) => {
      node.marks.forEach((m) => {
        if (m.type.name === 'highlight') found = true
      })
    })
    expect(found).toBe(true)
  })

  test('==text== parses to highlight mark', () => {
    const doc = parseMarkdown('Hello ==world== end\n')
    let found = false
    doc.descendants((node) => {
      node.marks.forEach((m) => {
        if (m.type.name === 'highlight') found = true
      })
    })
    expect(found).toBe(true)
  })

  test('empty ^^^^ produces no highlight mark', () => {
    const doc = parseMarkdown('Hello ^^^^ end\n')
    let found = false
    doc.descendants((node) => {
      node.marks.forEach((m) => {
        if (m.type.name === 'highlight') found = true
      })
    })
    expect(found).toBe(false)
  })
})
```

- [ ] **Step 2.2：运行测试，确认 fail**

```bash
cd ~/git/moraya-core && pnpm test -- --reporter=verbose 2>&1 | grep -E "parsing|FAIL|Error"
```

Expected: `^^text^^ parses to highlight mark` 和 `==text== parses to highlight mark` 失败

- [ ] **Step 2.3：启用 markdown-it `mark` 插件（支持 `==text==`）**

将 `src/markdown.ts` 第 38 行：

```typescript
  .enable(['table', 'strikethrough'])
```

改为：

```typescript
  .enable(['table', 'strikethrough', 'mark'])
```

- [ ] **Step 2.4：在 md 实例之后添加 `^^text^^` 的 inline rule**

在 `src/markdown.ts` 第 40 行（`.use(texmathPlugin)` 结束后，`// ── Paired HTML tag` 注释之前）插入：

```typescript
// ── Caret highlight rule: ^^text^^ → caret_highlight_open/close ──────────────

md.inline.ruler.push('caret_highlight', (state, silent) => {
  const start = state.pos
  // Require opening ^^
  if (state.src.charCodeAt(start) !== 0x5E /* ^ */) return false
  if (state.src.charCodeAt(start + 1) !== 0x5E /* ^ */) return false

  const contentStart = start + 2
  if (contentStart >= state.posMax) return false

  // Find closing ^^
  let closeIdx = -1
  for (let i = contentStart; i < state.posMax - 1; i++) {
    if (state.src.charCodeAt(i) === 0x5E && state.src.charCodeAt(i + 1) === 0x5E) {
      closeIdx = i
      break
    }
  }
  // Reject: no closing ^^ or empty content
  if (closeIdx < 0 || closeIdx === contentStart) return false

  if (!silent) {
    state.push('caret_highlight_open', 'mark', 1).markup = '^^'
    const token = state.push('text', '', 0)
    token.content = state.src.slice(contentStart, closeIdx)
    state.push('caret_highlight_close', 'mark', -1).markup = '^^'
  }
  state.pos = closeIdx + 2
  return true
})
```

- [ ] **Step 2.5：在 tokenHandlers 对象中添加 highlight mark 映射**

在 `src/markdown.ts` 中的 `tokenHandlers` 对象（`// ── Mark tokens ──` 注释区域），在 `link` 条目之后、对象结束 `}` 之前添加：

```typescript
  mark: { mark: 'highlight' },           // ==text==（markdown-it mark 插件）
  caret_highlight: { mark: 'highlight' }, // ^^text^^（自定义 inline rule）
```

最终该区域如下：

```typescript
  // ── Mark tokens ──
  em: { mark: 'em' },
  strong: { mark: 'strong' },
  s: { mark: 'strike_through' },
  code_inline: { mark: 'code', noCloseToken: true },
  link: {
    mark: 'link',
    getAttrs(token) {
      // ... 保持不变 ...
    },
  },
  mark: { mark: 'highlight' },
  caret_highlight: { mark: 'highlight' },
}
```

- [ ] **Step 2.6：运行测试，确认 pass**

```bash
cd ~/git/moraya-core && pnpm test -- --reporter=verbose 2>&1 | grep -E "parsing|PASS|FAIL|✓|×"
```

Expected: `highlight mark — parsing` 下 3 个测试全部 `✓`

- [ ] **Step 2.7：commit**

```bash
cd ~/git/moraya-core
git add src/markdown.ts src/__tests__/highlight.spec.ts
git commit -m "feat: add markdown-it highlight parsing (^^text^^ and ==text==)"
```

---

## Task 3：添加序列化器 mark + roundtrip fixture（moraya-core/markdown.ts）

**Files:**
- Modify: `~/git/moraya-core/src/markdown.ts:769-782`（serializer marks 区域）
- Create: `~/git/moraya-core/src/__tests__/fixtures/11-highlight.md`
- Test: `~/git/moraya-core/src/__tests__/highlight.spec.ts`

- [ ] **Step 3.1：在 highlight.spec.ts 追加序列化测试**

在现有测试之后添加：

```typescript
describe('highlight mark — serialization', () => {
  test('highlight mark serializes to ^^text^^', () => {
    const doc = parseMarkdown('Hello ^^world^^ end\n')
    const out = serializeMarkdown(doc)
    expect(out).toContain('^^world^^')
  })

  test('==text== input roundtrips as ^^text^^', () => {
    const doc = parseMarkdown('Hello ==world== end\n')
    const out = serializeMarkdown(doc)
    expect(out).toContain('^^world^^')
  })

  test('second roundtrip is byte-stable for ^^text^^', () => {
    const input = 'Hello ^^world^^ end\n'
    const md1 = serializeMarkdown(parseMarkdown(input))
    const md2 = serializeMarkdown(parseMarkdown(md1))
    expect(md2).toBe(md1)
  })
})
```

- [ ] **Step 3.2：运行测试，确认 fail**

```bash
cd ~/git/moraya-core && pnpm test -- --reporter=verbose 2>&1 | grep -E "serializ|FAIL|Error"
```

Expected: serialization 测试失败（输出 `<mark>text</mark>` 或序列化为空）

- [ ] **Step 3.3：在 MarkdownSerializer marks 配置中添加 highlight**

在 `src/markdown.ts` 的 serializer 的 marks 区域（`strike_through` 之后、`html_mark` 之前），添加：

```typescript
    highlight: {
      open: '^^',
      close: '^^',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
```

最终该区域如下：

```typescript
    strike_through: {
      open: '~~',
      close: '~~',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    highlight: {
      open: '^^',
      close: '^^',
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    html_mark: {
      open(_state: MarkdownSerializerState, mark: Mark) {
        return mark.attrs.openTag as string
      },
      // ...
    },
```

- [ ] **Step 3.4：创建 roundtrip fixture 文件**

新建 `~/git/moraya-core/src/__tests__/fixtures/11-highlight.md`：

```markdown
Inline ^^caret highlight^^ text.

Mixed **bold and ^^highlight^^** together.

Paragraph with ==equals highlight== syntax.
```

- [ ] **Step 3.5：运行测试，确认 pass**

```bash
cd ~/git/moraya-core && pnpm test -- --reporter=verbose 2>&1 | grep -E "highlight|roundtrip|PASS|FAIL|✓|×"
```

Expected: highlight 全部测试 `✓`，roundtrip 的 `11-highlight.md` 也 `✓`

- [ ] **Step 3.6：commit**

```bash
cd ~/git/moraya-core
git add src/markdown.ts src/__tests__/highlight.spec.ts src/__tests__/fixtures/11-highlight.md
git commit -m "feat: serialize highlight mark as ^^text^^, add roundtrip fixture"
```

---

## Task 4：添加 `Mod-h` keymap + 导出 `toggleHighlight`（moraya-core）

**Files:**
- Modify: `~/git/moraya-core/src/setup.ts:386`（keymap 绑定）
- Modify: `~/git/moraya-core/src/commands.ts`（添加 toggleHighlight）
- Modify: `~/git/moraya-core/src/index.ts`（导出 toggleHighlight）
- Test: `~/git/moraya-core/src/__tests__/api-contract.spec.ts`

- [ ] **Step 4.1：在 api-contract.spec.ts 追加 schema 验证和 command 测试**

在 `createSchema()` describe 块中补充：

```typescript
  test('schema.marks.highlight is defined', () => {
    const schema = createSchema({ mediaResolver: new BrowserMediaResolver() })
    expect(schema.marks.highlight).toBeDefined()
  })
```

在文件末尾添加：

```typescript
import { toggleHighlight } from '../index'

describe('toggleHighlight command', () => {
  test('is a function', () => {
    expect(typeof toggleHighlight).toBe('function')
  })
})
```

- [ ] **Step 4.2：运行测试，确认 fail**

```bash
cd ~/git/moraya-core && pnpm test -- --reporter=verbose 2>&1 | grep -E "toggleHighlight|FAIL"
```

Expected: `toggleHighlight` import 失败（不存在）

- [ ] **Step 4.3：在 commands.ts 末尾添加 toggleHighlight**

在 `src/commands.ts` 文件末尾添加：

```typescript
export const toggleHighlight: Command = (state, dispatch) =>
  toggleMark(markType('highlight'))(state, dispatch)
```

- [ ] **Step 4.4：在 index.ts 导出 toggleHighlight**

将 `src/index.ts` 的 commands 导出块：

```typescript
export {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleCode,
  // ...
} from './commands'
```

改为（在 `toggleStrikethrough` 之后添加）：

```typescript
export {
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleHighlight,
  toggleCode,
  setHeading,
  toggleBlockquote,
  toggleOrderedList,
  toggleBulletList,
  toggleCodeBlock,
  insertTable,
  insertHorizontalRule,
  insertMathBlock,
  toggleLink,
  insertImage,
} from './commands'
```

- [ ] **Step 4.5：在 setup.ts 的 keymap 绑定中添加 Mod-h**

将 `src/setup.ts` 第 386 行区域（`// Marks` 注释下方）：

```typescript
    ...(M.strong ? { 'Mod-b': toggleMark(M.strong) } : {}),
    ...(M.em ? { 'Mod-i': toggleMark(M.em) } : {}),
    ...(M.code ? { 'Mod-e': toggleMark(M.code) } : {}),
    ...(M.strike_through ? { 'Mod-Shift-x': toggleMark(M.strike_through) } : {}),
```

改为：

```typescript
    ...(M.strong ? { 'Mod-b': toggleMark(M.strong) } : {}),
    ...(M.em ? { 'Mod-i': toggleMark(M.em) } : {}),
    ...(M.code ? { 'Mod-e': toggleMark(M.code) } : {}),
    ...(M.strike_through ? { 'Mod-Shift-x': toggleMark(M.strike_through) } : {}),
    ...(M.highlight ? { 'Mod-h': toggleMark(M.highlight) } : {}),
```

- [ ] **Step 4.6：运行全部测试，确认无 regression**

```bash
cd ~/git/moraya-core && pnpm test 2>&1 | tail -20
```

Expected: 所有测试通过，无 FAIL

- [ ] **Step 4.7：commit**

```bash
cd ~/git/moraya-core
git add src/setup.ts src/commands.ts src/index.ts src/__tests__/api-contract.spec.ts
git commit -m "feat: Mod-h keymap and toggleHighlight command"
```

---

## Task 5：构建 moraya-core + 链接到 mdeditor

**Files:**
- Build: `~/git/moraya-core/dist/`（构建产物）
- Modify: `~/git/mdeditor/package.json`（dependency 改为 file: 路径）

- [ ] **Step 5.1：安装 moraya-core 依赖并构建**

```bash
cd ~/git/moraya-core && pnpm install && pnpm build
```

Expected：`dist/` 目录出现 `index.js`、`schema.js`、`markdown.js`、`setup.js`、`commands.js` 等文件，无构建错误

- [ ] **Step 5.2：更新 mdeditor 的 @moraya/core 依赖**

将 `~/git/mdeditor/package.json` 中：

```json
"@moraya/core": "^0.1.0",
```

改为：

```json
"@moraya/core": "file:../moraya-core",
```

- [ ] **Step 5.3：在 mdeditor 重新安装依赖**

```bash
cd ~/git/mdeditor && pnpm install
```

Expected：pnpm 提示链接了 `@moraya/core` 到本地路径，无报错

- [ ] **Step 5.4：运行 mdeditor 测试，确认 moraya-core 类型可用**

```bash
cd ~/git/mdeditor && pnpm test 2>&1 | tail -10
```

Expected：所有已有测试通过，无导入错误

- [ ] **Step 5.5：commit moraya-core 的构建产物（如项目规范要求 dist 入库）**

```bash
cd ~/git/moraya-core
git add dist/
git commit -m "chore: build dist for file: link consumption"
```

- [ ] **Step 5.6：commit mdeditor 的依赖更新**

```bash
cd ~/git/mdeditor
git add package.json pnpm-lock.yaml
git commit -m "chore: link @moraya/core to local fork for highlight development"
```

---

## Task 6：添加 marked 渲染扩展（mdeditor/host-render-html.ts）

**Files:**
- Modify: `~/git/mdeditor/src/lib/plugins/host-render-html.ts`
- Modify: `~/git/mdeditor/src/lib/plugins/host-render-html.test.ts`

- [ ] **Step 6.1：在 host-render-html.test.ts 追加 failing 测试**

在文件末尾添加：

```typescript
// 需要在顶部 import 区域额外导入 renderTabBody（或通过渲染函数测试）
// host-render-html 使用 sharedMarked 内部实例，通过 renderTabBody 间接测试
import { renderTabBody } from './host-render-html'

describe('highlight rendering', () => {
  it('renders ^^text^^ as <mark>text</mark>', async () => {
    const tab = { kind: 'markdown', currentContent: 'Hello ^^world^^ end\n', filePath: '/tmp/test.md' } as never
    const html = await renderTabBody(tab)
    expect(html).toContain('<mark>world</mark>')
  })

  it('renders ==text== as <mark>text</mark>', async () => {
    const tab = { kind: 'markdown', currentContent: 'Hello ==world== end\n', filePath: '/tmp/test.md' } as never
    const html = await renderTabBody(tab)
    expect(html).toContain('<mark>world</mark>')
  })

  it('does not XSS on ^^<script>^^ content', async () => {
    const tab = { kind: 'markdown', currentContent: '^^<script>alert(1)</script>^^\n', filePath: '/tmp/test.md' } as never
    const html = await renderTabBody(tab)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
```

- [ ] **Step 6.2：运行 mdeditor 测试，确认 fail**

```bash
cd ~/git/mdeditor && pnpm test 2>&1 | grep -E "highlight rendering|FAIL|Error"
```

Expected: 3 个 highlight rendering 测试失败

- [ ] **Step 6.3：在 host-render-html.ts 中添加 marked 扩展**

在 `src/lib/plugins/host-render-html.ts` 文件中，在现有 imports 之后（`blockCitationExtension` import 附近）添加：

```typescript
import type { TokenizerAndRendererExtension } from 'marked'
```

然后在 `blockCitationExtension` import 之后，`sharedMarked` 定义之前，添加两个扩展：

```typescript
const highlightCaretExtension: TokenizerAndRendererExtension = {
  name: 'highlightCaret',
  level: 'inline',
  start(src: string) { return src.indexOf('^^') },
  tokenizer(src: string) {
    const m = /^\^\^([^^]+)\^\^/.exec(src)
    if (!m) return undefined
    return { type: 'highlightCaret', raw: m[0], text: m[1] } as ReturnType<typeof this.tokenizer>
  },
  renderer(token: ReturnType<typeof this.tokenizer> & Record<string, unknown>) {
    return `<mark>${htmlEscape(String(token['text']))}</mark>`
  },
}

const highlightEqExtension: TokenizerAndRendererExtension = {
  name: 'highlightEq',
  level: 'inline',
  start(src: string) { return src.indexOf('==') },
  tokenizer(src: string) {
    const m = /^==([^=\n]+)==/.exec(src)
    if (!m) return undefined
    return { type: 'highlightEq', raw: m[0], text: m[1] } as ReturnType<typeof this.tokenizer>
  },
  renderer(token: ReturnType<typeof this.tokenizer> & Record<string, unknown>) {
    return `<mark>${htmlEscape(String(token['text']))}</mark>`
  },
}
```

- [ ] **Step 6.4：将扩展注册到 sharedMarked**

将现有：

```typescript
sharedMarked.use({ extensions: [blockCitationExtension] })
```

改为：

```typescript
sharedMarked.use({ extensions: [blockCitationExtension, highlightCaretExtension, highlightEqExtension] })
```

- [ ] **Step 6.5：运行测试，确认 pass**

```bash
cd ~/git/mdeditor && pnpm test 2>&1 | grep -E "highlight|PASS|FAIL|✓|×"
```

Expected: 3 个 highlight rendering 测试全部 `✓`，已有测试无 regression

- [ ] **Step 6.6：commit**

```bash
cd ~/git/mdeditor
git add src/lib/plugins/host-render-html.ts src/lib/plugins/host-render-html.test.ts
git commit -m "feat: marked extensions for ^^highlight^^ and ==highlight== rendering"
```

---

## Task 7：添加 SourceView cmd+H 快捷键 + source 视图语法高亮

**Files:**
- Modify: `~/git/mdeditor/src/components/SourceView.svelte`

（SourceView 是 DOM 交互组件，无法纯单元测试，此 task 为手动验证）

- [ ] **Step 7.1：在 `onTextareaKeydown` 中添加 cmd+H 处理**

在 `src/components/SourceView.svelte` 的 `onTextareaKeydown` 函数中，在现有 `Ctrl+Enter` 处理块之后添加：

```typescript
  if ((ev.metaKey || ev.ctrlKey) && ev.key === 'h') {
    ev.preventDefault()
    const el = textareaEl!
    const start = el.selectionStart ?? 0
    const end = el.selectionEnd ?? 0
    const before = value.slice(0, start)
    const after = value.slice(end)
    const selected = value.slice(start, end)
    const newVal = before + '^^' + selected + '^^' + after
    el.value = newVal
    el.selectionStart = start + 2
    el.selectionEnd = end + 2
    el.dispatchEvent(new Event('input'))
    return
  }
```

完整函数如下：

```typescript
  async function onTextareaKeydown(ev: KeyboardEvent) {
    if (!settings.mdblock.enabled) return
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      const handled = await cmdMdblockFollowCitationAtCursor()
      if (handled) {
        ev.preventDefault()
        ev.stopPropagation()
      }
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'h') {
      ev.preventDefault()
      const el = textareaEl!
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      const before = value.slice(0, start)
      const after = value.slice(end)
      const selected = value.slice(start, end)
      const newVal = before + '^^' + selected + '^^' + after
      el.value = newVal
      el.selectionStart = start + 2
      el.selectionEnd = end + 2
      el.dispatchEvent(new Event('input'))
    }
  }
```

- [ ] **Step 7.2：在 `highlight()` 函数中添加 `^^`/`==` 视觉标注**

将 `src/components/SourceView.svelte` 中的 `highlight()` 函数：

```typescript
  function highlight(src: string): string {
    const lines = src.split('\n').map((line) => {
      const m = line.match(/^(#{1,6})(\s.*)?$/)
      if (m) {
        const level = m[1].length
        return `<span class="h h${level}">${escapeHtml(line)}</span>`
      }
      return escapeHtml(line) || ' '
    })
    // Trailing space ensures pre matches textarea height when value ends with newline
    return lines.join('\n') + '\n'
  }
```

改为：

```typescript
  function highlight(src: string): string {
    const lines = src.split('\n').map((line) => {
      const m = line.match(/^(#{1,6})(\s.*)?$/)
      if (m) {
        const level = m[1].length
        return `<span class="h h${level}">${escapeHtml(line)}</span>`
      }
      let out = escapeHtml(line) || ' '
      out = out.replace(/(\^\^)([^^]+)(\^\^)/g, '<span class="hl-mark">$1$2$3</span>')
      out = out.replace(/(==)([^=\n]+)(==)/g, '<span class="hl-mark">$1$2$3</span>')
      return out
    })
    // Trailing space ensures pre matches textarea height when value ends with newline
    return lines.join('\n') + '\n'
  }
```

- [ ] **Step 7.3：在 SourceView 的 `<style>` 区域添加 .hl-mark 样式**

在 `src/components/SourceView.svelte` 的 `<style>` 块中，在已有样式末尾（`</style>` 之前）添加：

```css
  .hl-mark {
    background: #fff176;
    border-radius: 2px;
  }
```

- [ ] **Step 7.4：运行 mdeditor 全量测试，确认无 regression**

```bash
cd ~/git/mdeditor && pnpm test 2>&1 | tail -15
```

Expected: 所有测试通过

- [ ] **Step 7.5：commit**

```bash
cd ~/git/mdeditor
git add src/components/SourceView.svelte
git commit -m "feat: cmd+H highlight shortcut and ^^ == syntax highlight in source view"
```

---

## Task 8：推送 moraya-core fork + 验收

- [ ] **Step 8.1：推送 moraya-core 到 fork**

```bash
cd ~/git/moraya-core && git push origin main
```

- [ ] **Step 8.2：手动验收清单**

启动 mdeditor 开发服务（`pnpm tauri dev` 或 `pnpm dev`），逐项确认：

| # | 场景 | 预期结果 |
|---|------|----------|
| 1 | Rich editor 输入 `^^hello^^` 后按 Enter | 显示黄色背景高亮 |
| 2 | Rich editor 输入 `==hello==` 后按 Enter | 显示黄色背景高亮 |
| 3 | Rich editor 选中文字按 `cmd+H` | 文字被高亮；再按一次取消高亮 |
| 4 | Source view 选中文字按 `cmd+H` | 文字被 `^^...^^` 包裹 |
| 5 | Source view 无选区按 `cmd+H` | 插入 `^^^^` 光标在中间 |
| 6 | Source view 中 `^^text^^` | overlay 显示黄色背景标注 |
| 7 | Source view 中 `==text==` | overlay 显示黄色背景标注 |
| 8 | 导出 Share/PDF（含 `^^text^^`） | HTML 中出现 `<mark>text</mark>` |
| 9 | `==text==` 经 rich editor 保存后查看 markdown | 输出为 `^^text^^` |

- [ ] **Step 8.3：最终 commit（如有遗漏的小修正）**

```bash
cd ~/git/mdeditor && git add -p && git commit -m "fix: post-review tweaks for highlight feature"
```
