# Moraya 粘贴/拖拽功能复用分析

> 来源：`~/git/moraya/src/lib/editor/Editor.svelte` + 相关服务文件  
> 目标：移植到 `mdeditor/src/components/RichEditor.svelte`

---

## 架构背景

| 项目 | 编辑器层 | 应用层 |
|------|---------|--------|
| moraya | `@moraya/core`（ProseMirror 引擎，已打包） | `Editor.svelte`（图片粘贴、拖拽、上传等） |
| mdeditor | `@moraya/core`（同一包） | `RichEditor.svelte`（目前只有查找替换） |

**结论**：粘贴/拖拽逻辑全部在应用层（Svelte 组件 + Rust 命令），与 `@moraya/core` 无耦合，可直接移植。

---

## 可复用模块一览

### 1. 剪贴板图片粘贴（核心）

**来源**：`Editor.svelte` 第 822–865 行，`handlePaste` 函数

**功能**：在 ProseMirror 原生粘贴之前（capture 阶段）拦截 `ClipboardEvent`，检测 `image/*` MIME 类型 blob，走自定义路径：
- **Tauri 环境**：调用 `saveImageToDisk()` 写磁盘 → 插入相对/绝对文件路径
- **Web 环境**：创建 `blob:` URL → 直接插入图片节点

关键细节：
- 用 `event.stopImmediatePropagation()` 阻止 ProseMirror 将 HTML `<img src="data:...">` base64 插入
- 优先级高于 HTML 粘贴路径（截图/从浏览器复制图片会同时带 `text/html` 和 `image/png`）

**可直接复制**：是（需适配 `activeTab()?.filePath`）

---

### 2. 图片写盘 + 路径策略

**来源**：`Editor.svelte` 第 733–817 行，`saveImageToDisk` + `computeRelativePath` + `normalizePath`

**功能**：将 `File` blob 写入磁盘，返回在 markdown 中使用的路径字符串：

| 场景 | 保存位置 | markdown 路径形式 |
|------|---------|-----------------|
| 已保存文档（非 KB） | `{docDir}/images/` | `./images/image-xxx.png` |
| 已保存文档（在 KB 内） | `{kb}/images/{mirror}/` | 从 doc 到图片的相对路径 |
| 未保存文档（有 KB） | `{kb}/images/temp/` | 绝对路径 |
| 未保存文档（无 KB） | `{os.tempDir}/moraya-images/` | 绝对路径 |

**依赖 Rust 命令**：`invoke('write_file_binary', { path, base64Data })`  
**现状**：mdeditor 的 `src-tauri` 目前**没有**这个命令，需新增。

**可直接复制**：路径策略逻辑可复制；KB 相关分支（`computeImageDir`、`filesStore.getActiveKnowledgeBase`）可简化为只保留"已保存文档" + "未保存文档"两种情况。

---

### 3. Tauri 拖拽文件插入图片

**来源**：`Editor.svelte` 第 1884–1924 行，`dragDropUnlisten` 块

**功能**：监听 `getCurrentWebview().onDragDropEvent()`，过滤出图片扩展名的文件路径，转为 `blob:` URL 插入到拖放坐标对应的 ProseMirror 位置。

**依赖 Rust 命令**：`invoke('read_file_binary', { path })`（在 `readImageAsBlobUrl` 中使用）  
**现状**：mdeditor 同样**没有**这个命令，需新增。

**支持扩展名列表**（来自 `IMAGE_EXTENSIONS`）：
```ts
['png','jpg','jpeg','gif','svg','webp','bmp','ico','tiff','tif','avif']
```

**需同时**：在 `editorEl` 上注册 `dragover` / `drop` 并 `preventDefault()`，阻止浏览器默认行为。

**可直接复制**：是

---

### 4. 图片插入辅助函数

**来源**：`Editor.svelte` 第 625–660 行

三个函数，可全部复制（仅需确认 `schema` 来源）：

```ts
function insertImageAtPos(src: string, pos: number)   // 拖拽落点精确插入
function insertImageAtCursor(src: string)              // 粘贴时在光标处插入
function insertImageAtEnd(src: string)                 // 位置未知时兜底
```

mdeditor 中 `editor.view` 和 `schema` 可通过 `editor.view.state.schema` 访问。

---

### 5. Blob → BlobURL（读取本地文件）

**来源**：`file-service.ts` 第 128–136 行，`readImageAsBlobUrl`

```ts
export async function readImageAsBlobUrl(filePath: string): Promise<string> {
  const bytes = await invoke<number[]>('read_file_binary', { path: filePath });
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  return URL.createObjectURL(blob);
}
```

**依赖**：`invoke('read_file_binary', ...)`

---

### 6. 图片压缩工具（可选）

**来源**：`services/ai/image-utils.ts`，`compressImage` 函数

将大尺寸图片通过 Canvas 缩放到 1568px 以内，转为 JPEG（GIF 跳过）。目前 moraya 主要用于 AI vision 输入，但粘贴写盘前也可以选择是否压缩。

**可直接复制**：是，无外部依赖

---

### 7. 图像上传到图床（可选扩展）

**来源**：`services/image-hosting/providers.ts` + `uploadAndReplace`

支持 GitHub/GitLab/SM.MS/Imgur/自定义端点/七牛/OSS 等。`autoUpload` 模式下粘贴后立刻上传并替换 blob URL。

这部分与图床设置 UI 深度耦合，**不建议在第一期直接搬运**，但架构上是"粘贴 → 先 blob/本地路径 → 后台替换为云 URL"。

---

## 需要新增的 Rust 命令

| 命令名 | 签名 | 说明 |
|--------|------|------|
| `write_file_binary` | `(path: String, base64_data: String) → Result<(), String>` | 将 base64 字符串解码后写入文件（自动创建父目录） |
| `read_file_binary` | `(path: String) → Result<Vec<i32>, String>` | 读取文件为字节数组 |

moraya 的实现在 `src-tauri/src/commands/file.rs` 第 158 行，可直接参考。

---

## 不需要/不适合复制的部分

| 内容 | 原因 |
|------|------|
| KB（Knowledge Base）相关路径逻辑 | mdeditor 没有 KB 概念 |
| `filesStore.getActiveKnowledgeBase` | moraya 专有 store |
| `aiStore.addMessage` 上传成功/失败通知 | moraya 专有 AI panel |
| `fetchImageForNode` | 依赖 moraya 的图片节点右键菜单上下文 |
| `ImageContextMenu / ImageToolbar` | 这些是 moraya 专有 UI 组件 |
| 图床上传 UI（`ImageHostingSettings` 等） | 大量 moraya 专有设置逻辑，可单独立项 |

---

## 最小可行移植清单（第一期建议）

1. **Rust**：新增 `write_file_binary` 和 `read_file_binary` 两个命令
2. **`RichEditor.svelte`**：
   - 新增 `handlePaste(event)` 拦截剪贴板图片 blob
   - 新增 `saveImageToDisk(file)` 写盘（简化版，只需"已保存"+"未保存"两分支）
   - 新增 `insertImageAtCursor(src)` 插入 ProseMirror 图片节点
3. **Tauri 拖拽**：注册 `onDragDropEvent`，支持拖入图片文件
4. **路径处理**：`normalizePath` + `computeRelativePath`（纯函数，无依赖）

---

## 后续可扩展

- 粘贴 URL 自动转 `![](url)` 或 `[text](url)` 
- 粘贴非图片文件（PDF/文档）插入附件链接
- 图床自动上传（第二期）
