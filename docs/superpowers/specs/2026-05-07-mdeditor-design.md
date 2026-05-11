# mdeditor — 极简 Markdown 编辑器

**Date:** 2026-05-07
**Status:** Approved (brainstormed)
**Owner:** bruce@hemory.com

## 概述

从 moraya 中"提取内核"，构建一个**只编辑 md 文件**的独立 macOS 应用。无 AI、无 KB、无插件、无云、无 git、无 image hosting——只保留 markdown 编辑能力。

内核（`@moraya/core@0.1.0`）已发布到 npm 且 host-agnostic，本项目作为独立的下游消费者，从零初始化新仓库。

### 设计目标

1. 启动快（webview 启动后冷启动到首屏 < 300ms）
2. 体积小（macOS .app 目标 < 30MB；Vite bundle < 1MB gzip 不含懒加载渲染器）
3. 心智模型最小（< 25 个源文件，无路由、无 store framework、无 service 层）
4. macOS 一等公民（双击 .md / 拖入 / Dock drop / 标准菜单）
5. 富文本 + 源码双模式，富文本完整保留 highlight.js / KaTeX / Mermaid / 行内图片

### 非目标

- 跨平台（Windows / Linux 不打包）
- 多窗口（一个进程一个窗口，多文件用 tab）
- 文件外部变更检测、协同编辑、版本控制
- 任何形式的 AI / 网络服务

## 已锁定决策（brainstorming 输出）

| 维度 | 选择 |
|---|---|
| 编辑模式 | 双模式可切换（默认源码，可切富文本） |
| 窗口模型 | 单窗口标签页 |
| 富文本渲染器 | 全保留（highlight.js + KaTeX + Mermaid + 图片，按需懒加载） |
| 项目位置 | 全新独立仓库 `/Users/bruce/git/mdeditor` |
| 保存行为 | Cmd+S 手动 + 可选自动保存（设置开关） |
| 文件入口 | Cmd+O + 拖入 + .md 系统关联 + Dock drop |
| 主题 | 跟随系统，无切换 UI |
| 源码模式 | 纯 textarea，无行号、无源码语法高亮 |
| 设置面板 | 一个开关：启用自动保存 |
| Recent Files | 自维护 `settings.recentFiles[10]`，渲染到 File 菜单 |
| 菜单结构 | 标准 macOS：mdeditor / File / Edit / View / Window / Help |
| 空状态 | 提示性占位，不自动建草稿 |

## §1 仓库布局

```
/Users/bruce/git/mdeditor/
├── package.json                 # @moraya/core, @tauri-apps/{api,plugin-fs,
│                                #   plugin-dialog,plugin-opener,plugin-store,
│                                #   plugin-single-instance}, svelte, vite,
│                                #   @sveltejs/vite-plugin-svelte
├── vite.config.ts               # Vite + svelte 插件（无 SvelteKit）
├── tsconfig.json
├── index.html                   # 单 HTML 入口
├── src/
│   ├── main.ts                  # 挂载 App.svelte
│   ├── App.svelte               # 根：TabBar + EditorPane + 空状态
│   ├── components/
│   │   ├── TabBar.svelte
│   │   ├── EditorPane.svelte
│   │   ├── ModeToggle.svelte
│   │   ├── EmptyState.svelte
│   │   └── SettingsDialog.svelte
│   ├── lib/
│   │   ├── tabs.svelte.ts       # Svelte 5 $state — tabs / activeId / API
│   │   ├── editor-bridge.ts     # @moraya/core createEditor 薄封装
│   │   ├── fs.ts                # plugin-fs 包装 + 路径辅助
│   │   ├── settings.ts          # plugin-store 包装
│   │   └── adapters/
│   │       ├── tauri-media-resolver.ts
│   │       ├── tauri-link-opener.ts
│   │       └── renderer-registry.ts
│   └── styles/app.css           # @import '@moraya/core/style'
├── src-tauri/
│   ├── Cargo.toml               # tauri + 5 个 plugin
│   ├── tauri.conf.json          # fileAssociations: ['md','markdown']
│   ├── capabilities/default.json
│   ├── icons/
│   ├── Info.plist               # CFBundleDocumentTypes
│   └── src/
│       ├── main.rs              # 6 行
│       └── lib.rs               # 注册 plugins + 标准 macOS 菜单
└── README.md                    # 含手动 smoke 测试清单
```

总文件数 < 25。无 `services/`、无 `stores/`、无 `routes/`、无业务 commands。

## §2 Tab 状态模型

```ts
// src/lib/tabs.svelte.ts
type Tab = {
  id: string                  // crypto.randomUUID()
  filePath: string            // 绝对路径；v1 永远非 null（不实现 New File）
  title: string               // basename(filePath)
  initialContent: string      // 打开/保存后的"基线"
  currentContent: string      // 编辑缓冲区
  mode: 'source' | 'rich'
  // dirty 由 currentContent !== initialContent 派生（$derived）
}

export const tabs = $state<Tab[]>([])
export const activeId = $state<{ value: string | null }>({ value: null })

// 派生 helper
export function activeTab(): Tab | null {
  return tabs.find(t => t.id === activeId.value) ?? null
}

// 公共 API
openFile(path: string): Promise<void>
closeTab(id: string): Promise<boolean>
saveActive(): Promise<void>
saveAs(id: string): Promise<void>           // 仍保留，用于"另存为"导出到新路径
toggleMode(id: string): void
setContent(id: string, md: string): void
```

### 不变量

1. `dirty = currentContent !== initialContent`，从不手动设置
2. 同一 `filePath` 不允许有两个 tab；`openFile` 先去重
3. 关闭最后一个 tab → `activeId.value = null`，UI 显示 EmptyState；不自动建草稿
4. `saveAs` 后重新计算 `title`、`filePath`、`initialContent`（指向新文件，dirty 归 false）
5. v1 不提供 "New File" 入口，因此 `filePath` 永远是有效绝对路径

### 自动保存

- 仅在 `settings.autoSave === true` 时启用
- 每个 tab 独立 `$effect` 监听 `currentContent`，debounce 800ms
- 写盘成功 → 同步更新 `initialContent`，`dirty` 立即归 false
- 写盘失败 → 角落 toast 一次，**不**关闭自动保存

### 明确 YAGNI

- 文件外部变更检测
- 跨 tab 共享撤销栈
- 崩溃后草稿恢复

## §3 编辑器集成

```ts
// src/lib/editor-bridge.ts
import { createEditor as coreCreateEditor } from '@moraya/core'
import { tauriMediaResolver } from './adapters/tauri-media-resolver'
import { tauriLinkOpener } from './adapters/tauri-link-opener'
import { rendererRegistry } from './adapters/renderer-registry'
import { activeTab } from './tabs.svelte'
import type { Tab } from './tabs.svelte'

const platform = {
  getCurrentFilePath: () => activeTab()?.filePath ?? null,
  isMacOS: true,
}

export async function mountRichEditor(
  root: HTMLElement,
  tab: Tab,
  onChange: (md: string) => void,
) {
  return coreCreateEditor({
    container: root,
    initialContent: tab.currentContent,
    mediaResolver: tauriMediaResolver,
    linkOpener: tauriLinkOpener,
    rendererRegistry,
    platform,
    onChange,
    changeDebounceMs: 200,
  })
}
```

`coreCreateEditor` 内部会以 `mediaResolver` / `linkOpener` 构建 schema，并装配 `createEditorPlugins`。本应用不需要像 moraya 那样追加 `review-decoration` 插件，因此用核心的 `createEditor` 直通即可，**不**重复声明 schema。

### EditorPane 行为

- `mode === 'source'` → 渲染原生 `<textarea>`，`bind:value={tab.currentContent}`，无行号、无 outline、无源码高亮
- `mode === 'rich'` → 挂载 `mountRichEditor`，`onChange` 写回 `tab.currentContent`
- **切模式 / 切 tab 的 flush 顺序**：
  1. 调用富文本 editor 的 `getMarkdown()` **同步**读最新文档
  2. 写回旧 tab 的 `currentContent`（绕过 debounced onChange，避免丢最后一笔编辑）
  3. `editor.destroy()`
  4. 用新 tab 的 `currentContent` 重新挂载
- **无 editor 池**：永远只有当前激活 tab 的一个 editor 实例

### 渲染器注册（renderer-registry.ts）

```ts
export const rendererRegistry = {
  highlight: () => import('@moraya/core/renderers/highlight'),
  katex:     () => import('@moraya/core/renderers/katex'),
  mermaid:   () => import('@moraya/core/renderers/mermaid'),
}
```

具体导出名以 `@moraya/core` 实际接口为准；实施时读包确认。

### 冷启动路径

1. Vite bundle 极小（无 SvelteKit）
2. 启动只挂载空 App.svelte
3. 首次 openFile 才 lazy-import `@moraya/core`
4. 含 mermaid 块的 md 才 lazy-import mermaid

## §4 文件流程

### 4.1 打开

四个入口殊途同归到 `openFile(path)`：

```
Cmd+O          → plugin-dialog open()         ─┐
拖入窗口       → onDragDropEvent(paths)        ─┤
拖到 Dock      → single-instance 事件          ─┼─→ openFile(path)
双击 .md       → single-instance 事件          ─┘
```

`openFile`：

1. 校验后缀 ∈ {md, markdown, mdown, mkd}，否则 toast 拒绝
2. 查重：已有同 `filePath` 的 tab → 切换激活
3. `readTextFile(path)` 失败 → errorDialog，不开 tab
4. 推入 tabs，激活；`mode` 取 `settings.recentModes[path]`，无则默认 `'source'`

### 4.2 单实例 + 启动文件

```rust
// src-tauri/src/lib.rs
.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
    for arg in argv.iter().skip(1) {
        app.emit("open-file", arg).ok();
    }
}))
```

前端监听 `open-file` 事件 → `openFile(payload)`。

macOS 双击 .md 通过 `open-with` AppleEvent 自动转成 single-instance 启动参数，无需额外处理。

### 4.3 保存

```
Cmd+S → saveActive():
  if (filePath == null)  → saveAs()
  else                   → writeTextFile(filePath, currentContent)
                         → initialContent = currentContent
```

`saveAs()`：

```ts
plugin-dialog.save({
  defaultPath,
  filters: [{ name: 'Markdown', extensions: ['md'] }],
})
```

### 4.4 关闭 tab

```
closeTab(id):
  if (!dirty) → 直接移除
  else        → 原生确认对话框（保存 / 不保存 / 取消）
                保存 → saveActive() → 移除
                不保存 → 移除
                取消 → 不动
```

关闭最后一个 tab：保留窗口，显示 EmptyState。

### 4.5 关闭窗口

拦截窗口 `close-requested`，对每个 dirty tab 串行走 closeTab；任一取消 → 取消关窗。

### 4.6 自动保存

见 §2。失败 toast 但不关闭开关。

## §5 设置 / 菜单 / 错误处理 / 测试

### 5.1 设置（tauri-plugin-store）

`~/Library/Application Support/com.laobu.mdeditor/settings.json`：

```json
{
  "autoSave": false,
  "recentFiles": [],
  "recentModes": { "/abs/path/foo.md": "rich" }
}
```

```ts
// src/lib/settings.ts
export const settings = $state<{ autoSave: boolean }>({ autoSave: false })
loadSettings()    // 启动时灌进 $state
saveSettings()
getRecentMode(path) / setRecentMode(path, mode)
pushRecentFile(path)   // 截到 10
```

`SettingsDialog.svelte`：单复选框绑定 `settings.autoSave`。

### 5.2 菜单（macOS NSMenu via Tauri menu API）

构建在 `src-tauri/src/lib.rs`：

| Menu | Items |
|---|---|
| **mdeditor** | About / Preferences (Cmd+,) / Quit (Cmd+Q) |
| **File** | Open (Cmd+O) / Open Recent ▶ (动态) / Close Tab (Cmd+W) / Save (Cmd+S) / Save As (Cmd+Shift+S) |
| **Edit** | Undo / Redo / Cut / Copy / Paste / Select All（标准 system role） |
| **View** | Toggle Source/Rich Mode (Cmd+/) / Toggle Full Screen |
| **Window** | Minimize / Zoom（标准 role） |
| **Help** | Documentation（外链 README） |

**Open Recent**：自维护 `settings.recentFiles[10]`，菜单动态构建 menu items；初版**不**接入 macOS `NSDocumentController.recentDocumentURLs`。

### 5.3 错误处理

| 场景 | 行为 |
|---|---|
| 读文件失败 | 原生 errorDialog，不开 tab |
| 写文件失败（手动 Save） | errorDialog，dirty 保留 |
| 写文件失败（自动 Save） | 角落 toast 一次，dirty 保留 |
| 后缀不在白名单 | toast |
| 内核 parseMarkdown 异常（按理 never throws） | fallback 源码模式 + toast |
| 文件 > 10MB | 弹 confirm 让用户决定继续 / 取消 |

**不处理**：外部修改、磁盘空间、网络（不联网）。

### 5.4 测试

1. **`tabs.svelte.ts` 单测**（Vitest）：openFile 去重 / closeTab dirty 流程 / saveAs 路径更新 / auto-save debounce — 用假 fs 注入
2. **手动 smoke 清单**（README）：
   - 双击 .md 启动
   - Cmd+O 打开
   - 拖入窗口
   - 拖到 Dock
   - Cmd+S 保存
   - 修改后关闭 tab 弹确认
   - 切模式（源码 ⇄ 富文本）
   - 重启后 Open Recent 可见上次文件
3. **不写 e2e**

### 5.5 CI / 打包

- CI 仅 `vitest run` + `cargo check`
- Release 本地手 `pnpm tauri build --target universal-apple-darwin`，产出 universal `.app`

## 依赖清单

### Frontend

```jsonc
{
  "dependencies": {
    "@moraya/core": "^0.1.0",
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-fs": "^2",
    "@tauri-apps/plugin-dialog": "^2",
    "@tauri-apps/plugin-opener": "^2",
    "@tauri-apps/plugin-store": "^2",
    "@tauri-apps/plugin-single-instance": "^2"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "^5",
    "@tauri-apps/cli": "^2",
    "svelte": "^5",
    "typescript": "^5",
    "vite": "^6",
    "vitest": "^4"
  }
}
```

### Rust（src-tauri/Cargo.toml）

```toml
tauri = { version = "2", features = [] }
tauri-plugin-fs = "2"
tauri-plugin-dialog = "2"
tauri-plugin-opener = "2"
tauri-plugin-store = "2"
tauri-plugin-single-instance = "2"
```

### 不引入

- `@sveltejs/kit` / `@sveltejs/adapter-static`
- 任何状态管理库（Svelte 5 runes 即够）
- 任何 UI 组件库
- moraya 现有的 `tauri-plugin-http` / `keyring` / `mmap-rs` / `hnsw_rs` / `tokenizers` / `mermaid`（mermaid 由 @moraya/core 懒加载）等所有非编辑相关的 crate

## 风险 & 待验证

1. **`@moraya/core` 暴露的渲染器懒加载入口**：实施第一步是 `npm view @moraya/core` 或本地 `node_modules` 查实际导出，必要时调整 `renderer-registry.ts`
2. **macOS file association 在 Tauri 2 的最新写法**：`tauri.conf.json` 的 `bundle.fileAssociations` 字段已稳定，但需要 verify Info.plist 自动生成是否包含 `LSItemContentTypes`
3. **首次 codesign / notarization**：构建非目标，但若要分发需补 entitlements；初版仅本地用，跳过

## 落地路径（implementation plan 之后做）

1. `git init` + 拷贝/删改 moraya 的 `tauri.conf.json` 模板
2. 拷贝 3 个 adapter 文件（tauri-media-resolver / tauri-link-opener / renderer-registry）
3. 写 tabs.svelte.ts 并跑通 openFile / saveActive 单测
4. 写 EditorPane + 接入 @moraya/core
5. 接 Tauri menu / single-instance / drag-drop / file-association
6. 写 SettingsDialog + 接 plugin-store
7. 跑 smoke 清单
8. `pnpm tauri build`
