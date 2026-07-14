# 文件夹视图 视图模式（只看 markdown / 只看笔记）设计

日期：2026-07-14
承接：`2026-07-14-folder-view-sort-and-pin-design.md`（已发布 v5.27/5.28）
相关记忆：[[project_folder_view_sort_pin]]、[[reference_sidecar_notes_naming]]、[[file_over_app]]

## 背景与需求

folder-view 已有两个内容过滤复选框：`只显示有笔记的文件`(notesOnly)、`只显示文件`(filesOnly)。用户要再加两个：

1. **只看 markdown**：只显示 md 文件；每个 md 用其第一个 `# 一级标题`当显示名（无则用文件名），**不显示后缀**；伴生笔记 ✦ 角标照常显示在后面。
2. **只看笔记**：只显示 `.note.md`；显示名为文件名去掉后缀。

四个内容过滤互相矛盾（不能同时"只看 markdown"又"只看笔记"）。已确认的方向：

- 把内容过滤收成**单选视图模式**（不再是复选框）。
- markdown / 笔记模式**保留文件夹**供导航。
- H1 标题**仅在 markdown 模式惰性读文件 + 按 mtime 缓存**。

## 目标

单选 `viewMode` 取代 notesOnly/filesOnly；新增 markdown / notes 两模式；markdown 模式显示 H1 标题、去后缀、保留 ✦ 角标；notes 模式列出全部笔记（独立 + 配对）、去后缀名。只改可见文字，重命名/置顶仍用真实文件名。

非目标：递归拍平（各模式仍是逐层树 + 文件夹导航）；改动排序/置顶已有行为。

## 数据模型

### viewMode（单选，存 settings.json）

```ts
export type FolderViewMode = 'all' | 'files' | 'withNotes' | 'markdown' | 'notes'
export const DEFAULT_VIEW_MODE: FolderViewMode = 'all'
```

`folderView` state：加 `viewMode: FolderViewMode`；**移除** `notesOnly`/`filesOnly`。

迁移（`loadFolderViewState`）：读 `folderView.viewMode`；若未设置，则由旧键推导——`filesOnly→'files'`、否则 `notesOnly→'withNotes'`、否则 `'all'`。（旧 `applyNotesOnly`/`applyFilesOnly`/`setNotesOnly`/`setFilesOnly` 移除或替换。）

### 标题缓存（markdown 模式惰性）

```ts
// path → { mtime, title }；title=null 表示读过但无 H1
folderView.titleCache: SvelteMap<string, { mtime: number; title: string | null }>
```

## 纯函数

- `stripExt(name)`：去 `.md|.markdown|.mdown|.mkd`（大小写不敏感）。
- `stripNoteSuffix(name)`：去 `.notes?.md`。
- `parseFirstH1(text)`：返回首个 `^#\s+(.+)$` 行的标题(trim)，无则 `null`。
- `filterByViewMode(entries, mode)`：
  - `all` → entries
  - `files` → `!isDir`
  - `withNotes` → `isDir || hasNote===true`
  - `markdown` → `isDir || kind==='markdown'`
  - `notes` → `isDir || isOutlineNote || hasNote===true`（配对笔记经其主文档行体现，见渲染）
- `displayNameFor(entry, mode, title?)`：
  - `markdown` → `title`(非空) else `stripExt(entry.name)`
  - `notes` → `entry.hasNote ? stripNoteSuffix(basename(entry.notePath!)) : stripNoteSuffix(entry.name)`
  - 其他 → `entry.name`

## 渲染与交互

### 过滤位置
`FolderView.svelte` 的 `rootEntries` 与 `FolderTreeNode.svelte` 的 `children` 都改为 `filterByViewMode(filtered, folderView.viewMode)`（替换现有 `applyFilesOnly(applyNotesOnly(...))`）。名称过滤 `filterVisible` 仍先行。

### 显示名
`FolderTreeNode` 行 label 由 `{entry.name}` 改为 `displayNameFor(entry, mode, title)`。`title` 来自 `titleCache.get(entry.path)?.title`。**只改 `.label` 文本**；`title=` 悬浮、重命名 input 的 value、置顶/右键仍用 `entry.name`（真实文件名）。

### notes 模式打开目标
`FolderTreeNode.onRowClick`：`notes` 模式且 `entry.hasNote` → `onOpen(entry.notePath!)`；否则 `onOpen(entry.path)`。（配对笔记行显示去后缀名、点开对应 `.note.md`。）

### markdown 模式 H1 惰性读
`FolderTreeNode`：`$effect` 中，当 `mode==='markdown'` 且 `entry.kind==='markdown'` 且（未缓存或 `mtime` 变化）→ 调 `ensureTitle(entry)`：读文件、`parseFirstH1`、写 `titleCache`。读失败/无 H1 → 记 `title:null`（回退文件名）。只对已渲染的可见行触发（天然惰性）。

### ✦ 伴生笔记角标
markdown 模式下主文档行仍满足 `hasNote && notePath` → 角标照常渲染（无需改动该段）。

## store 新增

```ts
export async function setViewMode(mode: FolderViewMode): Promise<void>   // 存 settings.json，不重读盘
export async function ensureTitle(entry: FolderEntry): Promise<void>     // 惰性读 H1 → titleCache
```

`readFolder` 不变（仍出 mtime/birthtime/pinned 的配对+排序结果）；titleCache 与之解耦。

## i18n（`folderView.*`，en/zh/de/ja）

新增：`folderView.view`（分组名，可选）、`folderView.viewAll`、`folderView.viewFiles`、`folderView.viewWithNotes`、`folderView.viewMarkdown`、`folderView.viewNotes`。复用 `notesOnly`/`filesOnly` 的中文文案。旧 `notesOnly`/`filesOnly` 键可保留或改名为 view*。

- viewAll：全部 / All
- viewFiles：只显示文件 / Only files
- viewWithNotes：只显示有笔记的文件 / Files with notes
- viewMarkdown：只看 Markdown / Markdown only
- viewNotes：只看笔记 / Notes only

## 测试

单元（vitest 纯函数）：
- `stripExt`/`stripNoteSuffix`：各后缀 + 大小写。
- `parseFirstH1`：有 H1 / 无 H1 / 多标题取首个 / front-matter 中的键不误判。
- `filterByViewMode`：五种模式各自的保留集（含文件夹保留于 markdown/notes、隐藏于 files）。
- `displayNameFor`：markdown 有/无 title、notes 独立/配对（hasNote 用 notePath 去后缀）、其他模式原名。

手动 / GUI（[[feedback_no_ui_automation_user_tests]]）：
1. 排序菜单里视图模式是单选，切换即时生效、重启保留；旧的两复选框已并入。
2. 只看 markdown：只剩 md（+文件夹），行名显示 H1 标题、无后缀，主文档 ✦ 角标仍在；无 H1 的 md 显示文件名。
3. 只看笔记：只剩 .note.md（+文件夹），名字去后缀；配对笔记也列出且点开对应 .note.md。
4. 文件夹可展开钻取子目录，子目录内同样按模式过滤。

## 已决策 / 权衡

- 内容过滤改**单选视图模式**（含迁移旧 notesOnly/filesOnly）。
- markdown/notes **保留文件夹**导航。
- H1 **仅 markdown 模式惰性读 + mtime 缓存**，零默认开销。
- notes 模式**列出全部笔记**（独立 + 配对，配对经主文档行体现、点开 .note.md）。
- 显示名只改可见文字；重命名/置顶/悬浮仍用真实文件名。
