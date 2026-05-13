# Highlight Mark 设计文档

**日期**: 2026-05-13  
**状态**: 已批准，待实现

## 背景与目标

在 mdeditor 中扩展 Markdown 标记，支持文字高亮功能：

- 同时识别 `^^text^^`（主格式）和 `==text==`（兼容格式）
- Rich editor（ProseMirror）中视觉渲染为黄色背景高亮，`cmd+H` 切换
- Source view 中 `cmd+H` 用 `^^...^^` 包裹选区
- 导出（Share/PDF）时生成 `<mark>` HTML 标签
- 序列化统一输出 `^^text^^`

## 仓库说明

改动涉及两个仓库：

| 仓库 | 角色 |
|------|------|
| `~/git/moraya-core` (fork: `wizlijun/moraya-core`) | `@moraya/core` 源码，添加 `highlight` ProseMirror mark |
| `~/git/mdeditor` | 主应用，添加渲染扩展、SourceView 快捷键 |

## 数据流

```
输入: ^^text^^ 或 ==text==
  ↓ markdown-it (moraya-core)
  highlight ProseMirror mark（富文本视觉高亮）
  ↓ 序列化
  ^^text^^（统一写回）

输入: ^^text^^ 或 ==text==
  ↓ marked 扩展 (host-render-html.ts)
  <mark>text</mark>（Share/PDF 导出）
```

---

## 第一部分：`~/git/moraya-core` 改动

### 1. `src/schema.ts` — 添加 `highlight` MarkSpec

在 `strike_through` 定义之后，新增：

```ts
const highlight: MarkSpec = {
  parseDOM: [{ tag: 'mark' }],
  toDOM() { return ['mark', 0] as const },
}
```

将 `highlight` 加入 `marks` 对象：

```ts
const marks: Record<string, MarkSpec> = {
  html_mark,
  strong,
  em,
  code,
  link,
  strike_through,
  highlight,          // 新增
}
```

更新顶部 docstring 注释（Marks 数量 6→7，添加 `highlight`）。

### 2. `src/markdown.ts` — 解析与序列化

**a. 启用 markdown-it `mark` 插件（支持 `==text==`）**

```ts
const md = new MarkdownIt({ ... })
  .enable(['table', 'strikethrough', 'mark'])  // 新增 'mark'
  .use(deflistPlugin)
  .use(texmathPlugin)
```

**b. 添加自定义 inline rule（支持 `^^text^^`）**

在 `md` 实例创建后，添加：

```ts
md.inline.ruler.push('caret_highlight', (state, silent) => {
  const start = state.pos
  if (start + 4 > state.posMax) return false
  if (state.src.charCodeAt(start) !== 0x5E || state.src.charCodeAt(start + 1) !== 0x5E) return false

  const contentStart = start + 2
  const closeIdx = state.src.indexOf('^^', contentStart)
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

**c. 添加 token handler 映射**

在 `tokenHandlers` 对象（Mark tokens 区域）末尾添加：

```ts
mark: { mark: 'highlight' },           // ==text==
caret_highlight: { mark: 'highlight' }, // ^^text^^
```

**d. 添加 MarkdownSerializer mark 规则**

在 serializer 的 marks 配置（`strike_through` 之后）添加：

```ts
highlight: {
  open: '^^',
  close: '^^',
  mixable: true,
  expelEnclosingWhitespace: true,
},
```

### 3. `src/setup.ts` — 添加 `Mod-h` 快捷键

在 mark 快捷键区域（`Mod-Shift-x` 之后）添加：

```ts
...(M.highlight ? { 'Mod-h': toggleMark(M.highlight) } : {}),
```

### 4. 构建与发布

```bash
cd ~/git/moraya-core
pnpm install
pnpm build
```

开发阶段，mdeditor 通过 `file:` 路径引用本地 fork：

```json
// mdeditor/package.json
"@moraya/core": "file:../moraya-core"
```

---

## 第二部分：`~/git/mdeditor` 改动

### 5. `src/lib/plugins/host-render-html.ts` — marked 渲染扩展

导入类型并定义两个扩展（在现有 `blockCitationExtension` 导入附近）：

```ts
import type { TokenizerAndRendererExtension } from 'marked'

const highlightCaretExtension: TokenizerAndRendererExtension = {
  name: 'highlightCaret',
  level: 'inline',
  start(src) { return src.indexOf('^^') },
  tokenizer(src) {
    const m = /^\^\^([^\^]+)\^\^/.exec(src)
    if (!m) return undefined
    return { type: 'highlightCaret', raw: m[0], text: m[1] } as any
  },
  renderer(token: any) {
    return `<mark>${htmlEscape(String(token.text))}</mark>`
  },
}

const highlightEqExtension: TokenizerAndRendererExtension = {
  name: 'highlightEq',
  level: 'inline',
  start(src) { return src.indexOf('==') },
  tokenizer(src) {
    const m = /^==([^=\n]+)==/.exec(src)
    if (!m) return undefined
    return { type: 'highlightEq', raw: m[0], text: m[1] } as any
  },
  renderer(token: any) {
    return `<mark>${htmlEscape(String(token.text))}</mark>`
  },
}
```

在 `sharedMarked` 后注册：

```ts
sharedMarked.use({ extensions: [blockCitationExtension, highlightCaretExtension, highlightEqExtension] })
```

### 6. `src/components/SourceView.svelte` — cmd+H 快捷键

在 `onTextareaKeydown` 函数中，添加 `h` 键处理（在现有 Enter 处理之后）：

```ts
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

行为：有选区时包裹，无选区时插入 `^^^^` 并将光标置于中间。

### 7. `src/components/SourceView.svelte` — source 视图语法高亮

在 `highlight()` 函数中，对非标题行添加 `^^` / `==` 的视觉标注：

```ts
function highlight(src: string): string {
  const lines = src.split('\n').map((line) => {
    const m = line.match(/^(#{1,6})(\s.*)?$/)
    if (m) {
      const level = m[1].length
      return `<span class="h h${level}">${escapeHtml(line)}</span>`
    }
    let out = escapeHtml(line) || ' '
    out = out.replace(/(\^\^)([^\^]+)(\^\^)/g, '<span class="hl-mark">$1$2$3</span>')
    out = out.replace(/(==)([^=\n]+)(==)/g, '<span class="hl-mark">$1$2$3</span>')
    return out
  })
  return lines.join('\n') + '\n'
}
```

在 SourceView 的 `<style>` 中添加：

```css
.hl-mark { background: #fff176; border-radius: 2px; }
```

---

## 测试要点

1. `^^text^^` 在 rich editor 渲染为黄色背景
2. `==text==` 在 rich editor 渲染为黄色背景
3. `cmd+H` 在 rich editor 切换高亮（有选区时包裹，再次按下移除）
4. `cmd+H` 在 source view 插入 `^^...^^`
5. 序列化：`==text==` 输入 → rich editor → getMarkdown() 输出 `^^text^^`
6. 导出（Share/PDF）：`^^text^^` 和 `==text==` 都生成 `<mark>text</mark>`
7. Source view overlay 中 `^^text^^` 有黄色视觉提示

## 变更文件清单

### `~/git/moraya-core`
- `src/schema.ts`
- `src/markdown.ts`
- `src/setup.ts`

### `~/git/mdeditor`
- `package.json`（dependency 改为 `file:../moraya-core`）
- `pnpm-lock.yaml`（随 pnpm install 更新）
- `src/lib/plugins/host-render-html.ts`
- `src/components/SourceView.svelte`
