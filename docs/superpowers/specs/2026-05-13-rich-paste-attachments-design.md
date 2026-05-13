# Rich 模式粘贴与附件链接功能设计

**日期**：2026-05-13  
**状态**：待实现

---

## 目标

在 rich 模式编辑器（`RichEditor.svelte`）中支持：
1. 剪贴板截图粘贴 → 保存为本地图片，插入 `![](path)`
2. 拖拽图片文件 → 使用绝对路径插入 `![](path)`
3. 拖拽非图片文件（PDF/DOCX/ZIP 等）→ 插入附件链接 `[filename](path)`
4. 粘贴 URL → 识别文档扩展名时插入附件链接，否则交给 ProseMirror 原有逻辑

附件链接在 rich 视图中根据上下文渲染为**芯片**（行内）或**卡片**（独占一行），markdown 保持标准链接格式。

---

## 不在本期范围

- 图床自动上传（上传后替换 blob URL 为云 URL）
- 粘贴非图片二进制到剪贴板（OS 层面不支持，无需处理）
- 附件原始数据的统一资源管理（单独立项）
- 修改 `@moraya/core` 包

---

## Markdown 输出格式

| 场景 | Markdown |
|------|---------|
| 剪贴板截图 | `![](./images/image-1234567890.png)` |
| 拖拽图片文件 | `![](/absolute/path/to/photo.jpg)` |
| 拖拽文档文件 | `[report.pdf](/absolute/path/to/report.pdf)` |
| 粘贴文档 URL | `[report.pdf](https://example.com/report.pdf)` |

图片路径策略（剪贴板截图）：
- 已保存文档 → 相对路径 `./images/image-xxx.png`（写入 `{docDir}/images/`）
- 未保存文档 → 绝对路径（写入系统临时目录 `{tmpDir}/mdeditor-images/`）

---

## 架构

### 新增 Rust 命令

**`write_file_binary(path: String, base64_data: String) → Result<(), String>`**  
将 base64 字符串解码后写入文件，自动创建父目录。  
用于：剪贴板截图保存到磁盘。

**`read_file_binary(path: String) → Result<Vec<i32>, String>`**  
读取本地文件为字节数组。  
用于：拖拽图片文件时转为 blob URL 在编辑器中预览。

参考实现：`~/git/moraya/src-tauri/src/commands/file.rs:158`

### 新增前端文件

**`src/lib/attachment-link.ts`**

```ts
// 附件相关常量和工具函数
export const IMAGE_EXTENSIONS: Set<string>         // 图片扩展名集合
export const ATTACHMENT_EXTENSIONS: Set<string>    // 文档/二进制扩展名集合

export function isImagePath(path: string): boolean
export function isAttachmentPath(path: string): boolean
export function isAttachmentUrl(url: string): boolean  // URL 以文档扩展名结尾
export function basenameOf(path: string): string        // 取文件名
export function insertImageAtCursor(view, src): void
export function insertImageAtPos(view, src, pos): void
export function insertImageAtEnd(view, src): void
export function insertAttachmentLink(view, path, pos?): void  // 插入 [name](path)
```

**`src/lib/styles/attachment.css`**（或内嵌在 RichEditor.svelte 的 `<style>`）

见"视觉渲染"一节。

### 修改文件

**`src/components/RichEditor.svelte`**

新增：
- `handlePaste(event: ClipboardEvent)` — 注册在 capture 阶段，优先于 ProseMirror
- `setupDragDrop()` — 注册 Tauri `onDragDropEvent`，返回 unlisten 函数
- `saveImageToDisk(file: File): Promise<string | null>` — 写盘返回路径
- `normalizePath(p: string): string`
- `computeRelativePath(fromDir: string, toPath: string): string`

**`src-tauri/src/lib.rs`**

新增两个 Tauri 命令并注册到 `invoke_handler`。

---

## 粘贴处理逻辑

```
handlePaste(event: ClipboardEvent):

  1. 检查 clipboardData.items 是否含 image/* blob
     → 是：preventDefault + stopImmediatePropagation
            saveImageToDisk(file) → insertImageAtCursor(path)
            return

  2. 检查 clipboardData.getData('text/plain')
     → 是有效 URL 且 isAttachmentUrl(url)：
            insertAttachmentLink(view, url, cursorPos)
            return

  3. 其他情况：不拦截，交给 ProseMirror
```

注：步骤 1 必须先于 ProseMirror 的 HTML 粘贴处理，否则浏览器从网页复制图片时会同时带 `text/html`（含 base64 `<img>`），导致插入 base64 字符串而非本地文件路径。

---

## 拖拽处理逻辑

```
onDragDropEvent(event):
  paths = event.payload.paths
  position = event.payload.position  → 转为 ProseMirror pos

  for each path:
    if isImagePath(path):
      insertImageAtPos(view, path, dropPos)     // 直接用绝对路径
    else if isAttachmentPath(path):
      insertAttachmentLink(view, path, dropPos)
```

注意：拖拽图片时直接插入绝对路径，由 `tauriMediaResolver` 负责在 webview 中解析为可显示的 URL，无需读取文件字节。仅剪贴板截图（无文件来源）才需要 `write_file_binary` 写盘。`read_file_binary` 命令保留备用（未来可能需要读取文件内容）。

---

## 视觉渲染

通过 CSS 实现，不修改 ProseMirror schema。

### 扩展名匹配

需要提供附件卡片/芯片样式的扩展名（作为 CSS 选择器）：
`.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`,  
`.zip`, `.gz`, `.tar`, `.rar`, `.7z`,  
`.mp3`, `.wav`, `.ogg`, `.flac`,  
`.mp4`, `.mov`, `.avi`, `.mkv`,  
`.txt`, `.csv`, `.json`, `.xml`

### 芯片（行内，链接不是段落唯一内容）

```css
.ProseMirror a[href$=".pdf"],
.ProseMirror a[href$=".docx"],
/* ... */ {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px 1px 4px;
  border-radius: 4px;
  background: color-mix(in srgb, AccentColor 10%, Canvas);
  border: 1px solid color-mix(in srgb, AccentColor 25%, Canvas);
  font-size: 0.9em;
  text-decoration: none;
  white-space: nowrap;
}
.ProseMirror a[href$=".pdf"]::before { content: "📄 "; }
.ProseMirror a[href$=".zip"]::before,
.ProseMirror a[href$=".gz"]::before  { content: "🗜 "; }
/* 音视频、表格、文档等各自对应的 emoji */
```

### 卡片（独占一行）

```css
.ProseMirror p:has(> a[href$=".pdf"]:only-child),
.ProseMirror p:has(> a[href$=".docx"]:only-child),
/* ... */ {
  margin: 4px 0;
}

.ProseMirror p:has(> a[href$=".pdf"]:only-child) > a,
/* ... */ {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, AccentColor 8%, Canvas);
  border: 1px solid color-mix(in srgb, AccentColor 20%, Canvas);
  font-size: 0.9em;
  text-decoration: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

`::before` 在卡片模式下同样生效，图标自动放大（继承 flex 对齐）。

CSS 变量 `AccentColor` / `Canvas` 使用系统颜色，自动适配亮色/暗色主题。

---

## 扩展名常量定义

```ts
// attachment-link.ts
export const IMAGE_EXTENSIONS = new Set([
  'png','jpg','jpeg','gif','svg','webp','bmp','ico','tiff','tif','avif'
])

export const ATTACHMENT_EXTENSIONS = new Set([
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'zip','gz','tar','rar','7z',
  'mp3','wav','ogg','flac',
  'mp4','mov','avi','mkv','webm',
  'txt','csv','json','xml','md',
])
```

---

## 事件注册时序

```
onMount (RichEditor.svelte):
  1. 等待 mountRichEditor() 完成，获取 editor 实例
  2. proseMirrorEl.addEventListener('paste', handlePaste, true)   // capture
  3. editorEl.addEventListener('dragover', e => e.preventDefault())
  4. editorEl.addEventListener('drop', e => e.preventDefault())   // 阻止默认
  5. if (isTauri): dragDropUnlisten = await setupDragDrop()

onDestroy:
  1. proseMirrorEl.removeEventListener('paste', handlePaste, true)
  2. dragDropUnlisten?.()
```

---

## 不需要从 moraya 移植的部分

| 内容 | 原因 |
|------|------|
| KB 路径分支（`computeImageDir`、`filesStore.getActiveKnowledgeBase`） | mdeditor 无 KB 概念 |
| `uploadAndReplace` 图床上传 | 本期不做 |
| `ImageContextMenu / ImageToolbar` | moraya 专有 UI |
| `aiStore.addMessage` 通知 | moraya 专有 |
| `fetchImageForNode`（右键菜单路径） | 依赖 moraya 图片右键上下文 |
