# A4 打印功能设计

日期:2026-06-23

## 目标

为 M↓ 新增「Print… (Cmd+P)」功能:弹出 macOS 原生打印对话框,把当前文档按 A4
排版发送到打印机(用户也可在该对话框里另存为 PDF)。打印外观复用 md2pdf 插件已有
的 A4 打印样式,与 PDF 导出保持一致。

「打印」与现有的 md2pdf「导出 A4 PDF」是互补的两件事:
- md2pdf:走离屏 WKWebView + WKPDFConfiguration,生成 PDF 文件到指定路径。
- 本功能:走主 WebView 内的 `window.print()`,弹系统打印对话框,送物理打印机。

## 工作原理

打印通过主 WebView 内的一个**隐藏 iframe** + `window.print()` 实现,完全复用两块
现成基建,不引入新的渲染或样式来源:

1. **渲染**:`renderTabAsInlineBody(tab)`(`src/lib/plugins/host-render-html.ts`)
   —— 与 md2pdf / share 共用的同一条流水线:marked + KaTeX + 代码高亮 +
   mermaid/graphviz 转内联 SVG + 本地图片转 data URI。产出的是无 `<head>` 的 inline
   body 片段。

2. **样式**:`md2pdf/assets/pdf.css` —— 已含 `@page { size: A4; margin: 25mm 20mm }`、
   衡体(Charter)正文、页眉标题、页码等完整 A4 打印样式。该文件位于项目根下
   (`<root>/md2pdf/assets/pdf.css`),通过 Vite `?raw` 导入到 JS,保持**单一来源**
   ——打印与 PDF 导出共用同一份 CSS。

## 组件与改动(4 处)

### 1. 新建 `src/lib/print.ts`

- `wrapPrintHtml(body: string, title: string): string`
  纯函数。把 inline body 包成完整 HTML 文档:内联 `pdf.css`,`<title>` 与
  `<body data-pdf-title="...">` 均做 HTML 转义。镜像 md2pdf `template.rs` 的
  `wrap_html`。**可单元测试**。

- `printActiveTab(): Promise<void>`
  - 取 `activeTab()`;若无 tab,或 tab 为 `image` 类型 → `pushToast` 提示「无可打印
    内容」并返回(与 md2pdf 对图片 tab 的处理一致——图片不走 HTML 渲染)。
  - `renderTabAsInlineBody(tab)` 得到 body;`buildPdfTitle(tab)` 得到标题。
  - `wrapPrintHtml(body, title)` 包成完整文档。
  - 创建一个隐藏 `<iframe>`(`position:fixed; width:0; height:0; opacity:0; border:0`),
    `srcdoc` 设为文档;`onload` 后调用 `iframe.contentWindow.print()`;监听
    `afterprint`(并设兜底超时)后移除 iframe。
  - 该函数保持极薄,渲染/包裹逻辑都委托给可测的纯函数。

### 2. `src/lib/commands.ts`

- `CommandId` 联合类型新增 `'print'`。
- 新增 `cmdPrint()`,调用 `printActiveTab()`。
- 在 `handlers` 映射中注册 `'print': cmdPrint`。

### 3. `src/App.svelte`

- menu-event 的 `switch` 中新增 `case 'print': cmdPrint(); break`
  (`cmdPrint` 从 `./lib/commands` 引入)。

### 4. `src-tauri/src/lib.rs`(`build_menu`)

- File 子菜单在 "Save As…" 之后加一条分隔线,再加
  `MenuItemBuilder::with_id("print", "Print…").accelerator("Cmd+P")`。
- 原生菜单的 `Cmd+P` 加速键会拦截系统默认打印,改为 emit `menu-event("print")`。

## 数据流

```
用户按 Cmd+P / 点 File → Print…
  → Rust 原生菜单 emit menu-event("print")
  → App.svelte switch → cmdPrint()
  → printActiveTab()
      → renderTabAsInlineBody(activeTab())   [复用 host-render-html]
      → wrapPrintHtml(body, title)           [内联 md2pdf/assets/pdf.css]
      → 隐藏 iframe.srcdoc = doc
      → iframe.contentWindow.print()          [系统打印对话框]
      → afterprint → 移除 iframe
```

## 测试

- 对 `wrapPrintHtml` 写 vitest 单测(happy-dom 环境):
  - 输出含 `<!doctype html>`、内联的 pdf.css(断言含某段已知 CSS,如 `size: A4`)、
    `data-pdf-title` 属性、`<title>`。
  - 标题中的 `<`、`&`、`"` 被正确转义。
- `printActiveTab` 的 iframe + `window.print()` 路径不做单测(happy-dom 无打印实现),
  靠该函数保持极薄、把可测逻辑都抽到 `wrapPrintHtml` 来覆盖。

## 已知限制

`window.print()` 的 WebKit 路径**一定会**遵守 `@page` 的 A4 尺寸与页边距;但
`pdf.css` 里用 `@page` 命名边距框(`@top-center` 标题 / `@bottom-right counter(page)`
页码)实现的**页眉/页码**,在系统打印路径下 WebKit 可能不渲染——这是 WebKit 对
CSS paged-media 命名边距框支持有限导致的,与 md2pdf 走的 WKPDFConfiguration 路径不同。

结论:A4 版式、页边距、正文样式没问题;打印件上的「页眉标题 / 页码」可能不出现。
用户已确认接受此限制(不把页码列为本次硬需求)。

## 范围(YAGNI)

- 仅支持 markdown / code / html tab(与 md2pdf 一致);image tab 走 toast 提示返回。
- 不做打印预览界面、不做纸张尺寸选择 UI(系统对话框已提供)、不改 pdf.css。
- 不做 iOS 端打印(本次仅桌面菜单 + Cmd+P)。
