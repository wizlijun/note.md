# 复制渲染块为图像（Copy rendered block as image）

- 日期：2026-07-23
- 状态：已批准，待实现
- 影响仓库：`moraya-core`（改动全部落在此包）

## 背景与问题

在 rich（所见即所得）编辑器里，mermaid、graphviz/dot 这类代码块渲染成图后，代码块工具栏上的“复制”按钮仍然复制的是**源码文本**。用户期望：处于**预览态**时，该按钮直接把**渲染图像**放进系统剪贴板，方便粘贴到飞书 / PPT / Figma 等图片类应用。

## 目标（本次范围）

- 适用块：**Mermaid** 与 **Graphviz/dot**（以及经 `RendererRegistry` 注册、渲染成 SVG 的 renderer 块）。数学公式（KaTeX）不在本次范围。
- 剪贴板内容：**仅 PNG 图像**（不额外写文本、不写 SVG）。
- 触发方式：**复用现有的代码块复制按钮**，不新增按钮、不改快捷键与右键菜单。
  - **预览态** → 复制 PNG。
  - **编辑态 / 普通代码块** → 保持现有文本复制行为。

### 非目标

- 不改右键菜单、不改 Cmd+C 全局复制路径。
- 不处理数学公式块。
- 不做历史数据 / 文件格式改动（纯运行时行为）。

## 现状锚点（moraya-core）

- 文件：`src/plugins/code-block-view.ts`
- 复制按钮创建：`copyBtn`（约 `:453`），一直挂在 `toolbar` 上，预览态下也可见。
- 复制点击处理：`copyBtn` 的 `mousedown`（约 `:691`）→ 调 `handleCopy(copyBtn, code)`。
- 现有 `handleCopy`（约 `:399`）：`navigator.clipboard.writeText(code.textContent)`，成功后给按钮加 `copied` 类闪 1.5s。
- 预览容器：`mermaidPreview`（`.mermaid-preview`，约 `:480`）、`rendererPreview`（`.renderer-preview`，约 `:485`）。渲染后其内为 `<svg>`。
- 模式状态（闭包内）：`isMermaid`/`isEditing`、`isRenderer`/`rendererEditing`。
  - Mermaid 预览态判据：`isMermaid && !isEditing`。
  - Renderer 预览态判据：`isRenderer && !rendererEditing`。

## 设计

### 触发判定

在 `copyBtn` 的处理里，按当前模式选择行为：

1. Mermaid 预览态 → 目标预览元素 = `mermaidPreview`，走图像复制。
2. Renderer 预览态 → 目标预览元素 = `rendererPreview`，走图像复制。
3. 其它（含编辑态、普通代码块）→ 走现有 `handleCopy`（文本）。

图像复制若在任一步失败（见下），**回退到文本复制**，不弹错误。

### 取 SVG

从目标预览元素 `querySelector('svg')`。取不到（空图 `.mermaid-empty`、错误 `.mermaid-error`/`.renderer-error`、加载中 `.mermaid-loading`）→ 回退文本复制。

### SVG → PNG

1. `new XMLSerializer().serializeToString(svg)`；若根 `<svg>` 缺 `xmlns`，补 `http://www.w3.org/2000/svg`。
2. 尺寸：优先 `svg.viewBox.baseVal`（宽高 > 0 时用之），否则 `svg.getBoundingClientRect()`。
3. 缩放：按 `scale = 2` 放大画布（`canvas.width = w*scale`），保证清晰；`ctx.scale(scale, scale)`。
4. 背景：填 `getComputedStyle(preview).backgroundColor`；若为 `transparent` / `rgba(...,0)` / 空，则回退 `#ffffff`（适配深浅主题：深色预览容器通常有深色底，浅色则白底）。
5. 载图：将序列化后的 SVG 编码为 `data:image/svg+xml;charset=utf-8,<encodeURIComponent(...)>`，赋给 `new Image()`，`await` 其 `onload`（同时挂 `onerror` → reject）。
6. 绘制：`ctx.drawImage(img, 0, 0, w, h)`。
7. 导出：`canvas.toBlob(resolve, 'image/png')`。

### 写剪贴板（方案 A：纯 Web API）

- `navigator.clipboard.write([ new ClipboardItem({ 'image/png': blobPromise }) ])`。
- 采用 **Promise 形式** 的 `ClipboardItem`（`'image/png': <Promise<Blob>>`），以兼容 WKWebView/Safari 对“写剪贴板须在用户手势内”的要求——在 `mousedown` 内同步创建 `ClipboardItem`，把 SVG→PNG 的异步过程包在 Promise 里。
- 不给 moraya-core 引入 Tauri 依赖；与现有 `writeText` 同一套 API（该 webview 已验证可用）。浏览器构建同样可用。
- 若 `navigator.clipboard.write` / `ClipboardItem` 不存在或抛错 → 回退文本复制。

> 备选方案 B（不实施，除非 A 在 WKWebView 被拒）：moraya-core 暴露 `copyImage?(blob)` 选项，由 mdeditor 用 `@tauri-apps/plugin-clipboard-manager.writeImage` 实现。会给通用库加宿主耦合，故优先 A。

### 反馈

复制成功（图像或文本）后，复用现有 `copyBtn.classList.add('copied')` + `title='Copied!'`，1.5s 后复位。

## 已知限制

- mermaid 若使用 `foreignObject` 或外链字体，SVG→canvas 载图可能失败或字体缺失；此时 `img.onerror` 触发 → 回退文本复制，不报错。
- 透明 SVG 在填了背景色后不会有透明通道；这是刻意取舍（保证粘贴到白/深底应用可见）。

## 测试与验证

自动化（若可）：SVG→PNG 转换函数（纯函数部分：尺寸推导、xmlns 补全、背景回退）可单测。剪贴板写入依赖浏览器环境，不强求单测。

Dev 实机验证（GUI 行为，必须）：`tsup` 构建 moraya-core → `pnpm sync:core` → 重启 dev。逐项确认：

1. Mermaid 预览态点复制 → 粘贴到外部图片应用得到 PNG 图。
2. Graphviz/dot 预览态点复制 → 得到 PNG 图。
3. 编辑态 / 普通代码块点复制 → 仍复制文本。
4. 深色与浅色主题下，PNG 背景与图形对比正常（不出现看不见的图）。
5. 空 / 错误 / 加载中的块点复制 → 回退文本，不崩。

## 发布

moraya-core 改动 → 走 `tsup` + `pnpm sync:core`。GUI 行为改动须先 dev 实机验证通过，再按项目约定发布（日期版本号）。
