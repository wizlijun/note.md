# Rich 模式粘贴与附件链接功能设计

**日期**：2026-05-13  
**状态**：待实现

---

## 目标

在 rich 模式编辑器（`RichEditor.svelte`）中支持：
1. **剪贴板粘贴**（图片 blob 或二进制文件 blob）→ 保存到 `{docBasename}_files/`，插入相对路径引用
2. **拖拽图片文件** → 使用绝对路径直接插入 `![](path)`（不复制文件）
3. **拖拽非图片文件**（PDF/DOCX/ZIP 等）→ 使用绝对路径插入附件链接 `[filename](path)`
4. **粘贴 URL** → 识别文档扩展名时插入附件链接，否则交给 ProseMirror 原有逻辑

附件链接在 rich 视图中根据上下文渲染为**芯片**（行内）或**卡片**（独占一行），markdown 保持标准链接格式。

---

## 不在本期范围

- 图床自动上传
- 附件原始数据的统一资源管理（单独立项）
- 修改 `@moraya/core` 包

---

## 资源路径策略

### 剪贴板粘贴的资源（图片 blob / 二进制 blob）

统一保存到伴随目录 `{docBasename}_files/`，使用相对路径引用：

| 文档状态 | 保存位置 | Markdown 引用 |
|---------|---------|--------------|
| 已命名（已保存过） | `{docDir}/{docBasename}_files/` | `{docBasename}_files/image-xxx.png` |
| 未命名（新建未保存） | 临时目录（见下） | 绝对路径（临时） |

**文件命名**：`image-{timestamp}.{ext}` 或 `file-{timestamp}.{ext}`，避免冲突。

### 未命名文档的临时目录

- 路径：`{os.tmpDir}/mdeditor-paste/{sessionId}/`（`sessionId` = 应用启动时生成的随机串）
- 资源先以绝对路径写入此目录
- **当用户首次保存文档**（从无路径 → 有路径）时，触发**资源迁移**

### 资源迁移（首次保存时）

触发条件：tab 的 `filePath` 从 `null/undefined` 变为实际路径。

迁移步骤：
1. 扫描当前文档 markdown 内容，找出所有引用临时目录的路径
2. 在新文档目录下创建 `{docBasename}_files/` 目录
3. 将临时文件移动（`rename`）到新目录
4. 将文档中的绝对临时路径替换为相对路径 `{docBasename}_files/xxx`
5. 更新 tab 内容（触发正常保存流程）

---

## Markdown 输出格式

| 场景 | Markdown |
|------|---------|
| 剪贴板截图（已命名文档） | `![](report_files/image-1234567890.png)` |
| 剪贴板截图（未命名，迁移后） | `![](Untitled_files/image-1234567890.png)` |
| 剪贴板截图（未命名，迁移前） | `![](/tmp/mdeditor-paste/abc123/image-1234567890.png)` |
| 拖拽图片文件 | `![](/absolute/path/to/photo.jpg)` |
| 拖拽文档文件 | `[report.pdf](/absolute/path/to/report.pdf)` |
| 粘贴文档 URL | `[report.pdf](https://example.com/report.pdf)` |

---

## 架构

### 新增 Rust 命令

**`write_file_binary(path: String, base64_data: String) → Result<(), String>`**  
将 base64 字符串解码后写入文件，自动创建父目录。  
用于：剪贴板资源保存到磁盘。

**`rename_file(from: String, to: String) → Result<(), String>`**  
移动/重命名文件，自动创建目标父目录。  
用于：未命名文档首次保存时迁移临时资源。

参考实现：`~/git/moraya/src-tauri/src/commands/file.rs`

### 新增前端文件

**`src/lib/paste-resources.ts`**

```ts
// 资源保存与路径管理
export const IMAGE_EXTENSIONS: Set<string>
export const ATTACHMENT_EXTENSIONS: Set<string>

export function isImageExt(path: string): boolean
export function isAttachmentExt(path: string): boolean
export function isAttachmentUrl(url: string): boolean
export function basenameOf(path: string): string
export function extOf(path: string): string

// 计算伴随目录路径：{docDir}/{docBasename}_files/
export function filesDir(docFilePath: string): string

// 生成资源文件名：image-{timestamp}.png
export function resourceFilename(mimeOrExt: string): string

// 保存剪贴板资源到磁盘，返回插入 markdown 的路径字符串
// docFilePath = null 表示未命名文档（返回临时目录绝对路径）
export async function saveClipboardResource(
  file: File,
  docFilePath: string | null,
  sessionId: string,
): Promise<string>

// 扫描 markdown 内容，找出所有指向 tempDir 的路径
export function findTempRefs(
  markdown: string,
  tempDir: string,
): Array<{ absPath: string; match: string }>

// 迁移临时资源到 _files/ 目录，返回更新后的 markdown
export async function migrateTempResources(
  markdown: string,
  tempDir: string,
  newDocFilePath: string,
): Promise<string>
```

**`src/lib/attachment-insert.ts`**

```ts
// ProseMirror 插入辅助
export function insertImageAtCursor(view, src: string): void
export function insertImageAtPos(view, src: string, pos: number): void
export function insertAttachmentLink(view, path: string, pos?: number): void
```

**`src/lib/styles/attachment.css`**（或内嵌在 RichEditor.svelte）

见"视觉渲染"一节。

### 修改文件

**`src/components/RichEditor.svelte`**

新增：
- `handlePaste(event: ClipboardEvent)` — capture 阶段，优先于 ProseMirror
- `setupDragDrop()` → 返回 `UnlistenFn`，处理 Tauri 拖拽事件
- 监听 `tab.filePath` 变化，`null → 非null` 时触发 `migrateTempResources`

**`src-tauri/src/lib.rs`**

新增 `write_file_binary`、`rename_file` 两个命令，注册到 `invoke_handler`。

---

## 粘贴处理逻辑

```
handlePaste(event: ClipboardEvent):

  1. 遍历 clipboardData.items，找 image/* 或其他二进制 MIME
     → 找到：
         preventDefault + stopImmediatePropagation
         path = await saveClipboardResource(file, tab.filePath, sessionId)
         if 是图片 MIME：insertImageAtCursor(view, path)
         else：insertAttachmentLink(view, path, cursorPos)
         return

  2. 检查 clipboardData.getData('text/plain')
     → 是有效 URL 且 isAttachmentUrl(url)：
         insertAttachmentLink(view, url, cursorPos)
         return

  3. 其他情况：不拦截，交给 ProseMirror
```

注：步骤 1 必须在 capture 阶段拦截，防止 ProseMirror 将浏览器复制图片时附带的 HTML（含 base64 `<img>`）插入文档。

---

## 拖拽处理逻辑

```
onDragDropEvent(event):
  paths = event.payload.paths
  dropPos = view.posAtCoords(event.payload.position)?.pos ?? null

  for each path:
    if isImageExt(path):
      insertImageAtPos(view, path, dropPos)        // 绝对路径，不复制
    else if isAttachmentExt(path):
      insertAttachmentLink(view, path, dropPos)    // 绝对路径，不复制
```

拖拽文件已在磁盘上存在，`tauriMediaResolver` 负责在 webview 中解析路径为可显示 URL，无需读取文件字节。

---

## 资源迁移逻辑

触发时机：`RichEditor.svelte` 中监听 `tab.filePath`，当 `prevFilePath === null && newFilePath !== null` 时执行。

```ts
// $effect 监听
$effect(() => {
  const newPath = tab.filePath
  if (!newPath || prevFilePath !== null) return
  prevFilePath = newPath
  void (async () => {
    const updated = await migrateTempResources(
      tab.currentContent,
      getTempDir(sessionId),
      newPath,
    )
    if (updated !== tab.currentContent) {
      setContent(tab.id, updated)           // 更新 tab 内容
      editor?.setContent(updated)           // 同步到编辑器视图
    }
  })()
})
```

`migrateTempResources` 内部：
1. 调用 `findTempRefs(markdown, tempDir)` 找出所有临时路径
2. 对每个路径：`invoke('rename_file', { from: absPath, to: targetPath })`
3. 用正则替换 markdown 中的旧路径为新相对路径

---

## 视觉渲染

通过 CSS 实现，不修改 ProseMirror schema。利用 `p:has(> a:only-child)` 判断是否独占一行。

### 扩展名匹配范围

`.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`,  
`.zip`, `.gz`, `.tar`, `.rar`, `.7z`,  
`.mp3`, `.wav`, `.ogg`, `.flac`,  
`.mp4`, `.mov`, `.avi`, `.mkv`, `.webm`,  
`.txt`, `.csv`, `.json`, `.xml`

### 芯片（行内）

```css
.ProseMirror a[href$=".pdf"],
.ProseMirror a[href$=".docx"] /* ... */ {
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
/* 图标通过扩展名选择器注入 */
.ProseMirror a[href$=".pdf"]::before { content: "📄 "; }
.ProseMirror a[href$=".zip"]::before,
.ProseMirror a[href$=".gz"]::before  { content: "🗜 "; }
.ProseMirror a[href$=".mp3"]::before,
.ProseMirror a[href$=".wav"]::before { content: "🎵 "; }
.ProseMirror a[href$=".mp4"]::before,
.ProseMirror a[href$=".mov"]::before { content: "🎬 "; }
/* doc/docx/xls/xlsx/ppt/pptx → 📝 📊 📊 */
```

### 卡片（独占一行，`:only-child`）

```css
.ProseMirror p:has(> a[href$=".pdf"]:only-child) > a,
.ProseMirror p:has(> a[href$=".docx"]:only-child) > a
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
  overflow: hidden;
  text-overflow: ellipsis;
}
```

`AccentColor` / `Canvas` 为 CSS 系统颜色关键字，自动适配深浅主题。

---

## 事件注册时序

```
onMount (RichEditor.svelte):
  1. 等待 mountRichEditor() 完成
  2. proseMirrorEl.addEventListener('paste', handlePaste, true)
  3. editorEl.addEventListener('dragover', e => e.preventDefault())
  4. editorEl.addEventListener('drop',     e => e.preventDefault())
  5. if (isTauri): dragDropUnlisten = await setupDragDrop()

onDestroy:
  proseMirrorEl.removeEventListener('paste', handlePaste, true)
  dragDropUnlisten?.()
```

---

## 不需要从 moraya 移植的部分

| 内容 | 原因 |
|------|------|
| KB 路径分支（`computeImageDir` 等） | mdeditor 无 KB 概念 |
| `uploadAndReplace` 图床上传 | 本期不做 |
| `readImageAsBlobUrl` | 拖拽使用绝对路径，不读字节 |
| `ImageContextMenu / ImageToolbar` | moraya 专有 UI |
| `aiStore.addMessage` 通知 | moraya 专有 |
