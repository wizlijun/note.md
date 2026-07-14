# 文件夹视图 排序 + 置顶 设计

日期：2026-07-14
相关记忆：[[reference_i18n_system]]、[[file_over_app]]、[[project_outline_intent_save]]（"默认不自动创建/少写盘"同理念）

## 背景与需求

文件夹视图（左侧栏，`src/components/FolderView.svelte` + `src/lib/folder-view.svelte.ts`）当前只有一种排序：文件夹优先 + 文件名升序（`sortEntries`，folder-view.svelte.ts:118-124），`FolderEntry` 不含时间元数据，也无任何 per-folder 配置文件。

需求（用户原话归纳）：

1. 增加排序方式，**默认按最后编辑时间**；另有文件名顺序、创建时间倒序。
2. 增加置顶功能；置顶信息存到对应 folder 目录下的 `.notemd.json`，**默认不自动创建**。
3. **排序是全局一个设置**（存 settings.json），坚决不为排序建 per-folder 文件；尽量少往用户目录写文件。
4. 排序选择框里加一个复选框：**只显示有笔记(.note.md)的 md**（显示过滤，与排序正交）。

## 目标

- 三种全局排序：`edited`（mtime 倒序，默认）/ `name`（名字升序）/ `created`（birthtime 倒序）。
- 每目录置顶：`.notemd.json` 存置顶项名字，仅在有置顶时存在；取消最后一个置顶即删除该文件。
- 文件与文件夹均可置顶；置顶浮到该目录顶部，组内按置顶顺序（手动序）。

非目标：per-folder 排序记忆（明确用全局）；虚拟化渲染；跨端 `.notemd.json` 合并冲突处理（小文件，last-write-wins 接受）。

## 数据模型

### FolderEntry 扩展（folder-view.svelte.ts:11-21）

```ts
export interface FolderEntry {
  name: string
  path: string
  isDir: boolean
  kind: FileKind | null
  isOutlineNote?: boolean
  hasNote?: boolean
  notePath?: string
  mtime?: number       // 最后修改(ms)，stat 失败为 0
  birthtime?: number   // 创建(ms)，stat 失败为 0
  pinned?: boolean      // 名字 ∈ 本目录 .notemd.json pinned 集
}
```

### 排序键

```ts
export type FolderSortKey = 'edited' | 'name' | 'created'
export const DEFAULT_SORT: FolderSortKey = 'edited'
```

- `edited` → mtime 倒序（新→旧）
- `name` → localeCompare 升序（不区分大小写）
- `created` → birthtime 倒序（新→旧）

`folderView` state 增 `sort: FolderSortKey`（默认 `DEFAULT_SORT`）。

### 「只显示有笔记的 md」过滤

`folderView` state 增 `notesOnly: boolean`（默认 `false`，存 settings.json `folderView.notesOnly`）。开启时只显示"有配对笔记的主文档"（`hasNote === true`）+ 文件夹（保留导航）；纯文件、独立笔记（`isOutlineNote`）隐藏。与排序、名称过滤正交叠加（AND）。

### `.notemd.json`（per-folder，仅置顶）

```json
{ "pinned": ["Inbox", "读书笔记.md", "todo.md"] }
```

- 值是 entry 的 **name**（相对文件名/文件夹名，可移植）。
- 仅在有置顶时存在；`pinned` 变空 → 删除文件。
- 是点文件，`readFolder` 的 `!name.startsWith('.')` 过滤天然使其不显示在树里。

## 组件与函数

### 1. 纯函数 `sortEntries(entries, sort, pinned)` 重写

签名：`sortEntries(entries: FolderEntry[], sort: FolderSortKey, pinned: string[]): FolderEntry[]`

规则：

1. **置顶组在最前**：按 `pinned` 数组顺序取出 entries（用 name 匹配；数组里在本目录不存在的名字忽略）。组内**不**套用文件夹优先/排序键——严格数组序（手动序）。
2. **非置顶组**：保持"文件夹优先"，组内按 `sort`：
   - `name`：`a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })`
   - `edited`：`(b.mtime ?? 0) - (a.mtime ?? 0)`
   - `created`：`(b.birthtime ?? 0) - (a.birthtime ?? 0)`
   - 时间相等回退按名字升序（稳定、可预期）。
3. 返回 `[...置顶组, ...非置顶组]`。

### 2. `readFolder` 增 stat + 读 pins（folder-view.svelte.ts:155-171）

- 读目录、过滤点文件、classify 后：
  - `statFile(path)` 并行（`Promise.all`）填 `mtime`/`birthtime`（含文件夹；stat 失败回退 0）。
  - 读本目录 `.notemd.json`（`readPinned(dir)`，缺文件/坏 JSON → `[]`，不创建）。
  - 给每个 entry 标 `pinned = pinnedSet.has(name)`。
- `sortEntries(pairNoteEntries(entries), folderView.sort, pinned)` → 缓存。

### 3. pins IO（folder-view.svelte.ts 新增）

```ts
// 读：缺文件/坏 JSON/非数组 → []
export async function readPinned(dir: string): Promise<string[]>
// 切换置顶：读→改→写；空数组则删文件；写后 refresh 本目录
export async function togglePin(dir: string, name: string): Promise<void>
```

- `readPinned` 用 `@tauri-apps/plugin-fs` 的 `exists` + `readTextFile`，解析容错。
- `togglePin`：`exists` 则读现有 pinned，`name` 在则移除、不在则追加（追加到末尾）。结果空 → `remove(path)`（删文件）；否则 `writeTextFile` `{ pinned }`（2 空格缩进）。随后 `readFolder(dir)` 重读该目录刷新缓存。

### 4. 全局排序设置（folder-view.svelte.ts persistence）

```ts
export async function setSort(key: FolderSortKey): Promise<void>
```

- 置 `folderView.sort = key`，写 settings.json `folderView.sort`，`s.save()`。
- 就地重排所有已缓存目录：对 `entriesCache` 每个 dir，用已缓存 entries（含 mtime/birthtime/pinned）重新 `sortEntries` 后回写（无需重读盘）。
- `loadFolderViewState` 读 `folderView.sort`（默认 `DEFAULT_SORT`）。

### 5. 「只显示有笔记的 md」纯过滤 + 全局设置

```ts
// 纯函数：notesOnly 时保留文件夹 + hasNote 的条目；否则原样
export function applyNotesOnly(entries: FolderEntry[], notesOnly: boolean): FolderEntry[]
export async function setNotesOnly(v: boolean): Promise<void>   // 写 settings.json，不触发重读(渲染层过滤)
```

- 渲染层过滤（不改缓存）：`FolderView.svelte` 的 `rootEntries` 与 `FolderTreeNode` 的子项渲染都套 `applyNotesOnly`，并与名称过滤 `filterVisible` 组合。
- 折叠状态下的文件夹保留（不做子树扫描判空，代价小；空文件夹仍显示，权衡见下）。
- `loadFolderViewState` 读 `folderView.notesOnly`（默认 false）。

### 6. UI

- **排序菜单**（`FolderView.svelte` 工具栏）：新增排序图标按钮 → 小弹出菜单：三项排序（最后编辑时间 / 名称 / 创建时间，当前项打勾，点选调 `setSort`）+ 分隔 + 一个复选框行「只显示有笔记的 md」（勾选态 = `folderView.notesOnly`，点选调 `setNotesOnly`）。复用现有 `node-ctx-menu` 的定位/关闭模式（window mousedown/Esc 关闭）。
- **置顶开关**（右键菜单，`FolderView.svelte:65-82,197-208`）：新增一项，文件与文件夹都显示，按 `entry.pinned` 切"置顶"/"取消置顶"，点选调 `togglePin(parentDir(path), name)`。
- **置顶角标**（`FolderTreeNode.svelte`）：`pinned` 为真时行上显示小图钉图标。

### 7. i18n（`folderView.*`，en/zh/de/ja 四语言）

新增键：`folderView.sortBy`、`folderView.sortEdited`、`folderView.sortName`、`folderView.sortCreated`、`folderView.pin`、`folderView.unpin`、`folderView.notesOnly`。

## 文件监听/刷新

- 写/删 `.notemd.json` 会被现有递归 watcher 捕获（folder-view.svelte.ts:272-288）→ 150ms 防抖 `refreshAll` 重读。`.notemd.json` 被点文件过滤不显示，`refreshAll` 只重读 pins，无写→无循环。`togglePin` 自身也主动重读本目录，二者幂等一致。

## 性能

- `readFolder` 对每个 entry 多一次 `stat`（并行）。典型 vault 目录规模可接受；换来切换排序即时（无需重读）。大目录如成为瓶颈，后续可改为"仅时间排序时惰性 stat"，本期不做。

## 测试

单元（vitest，纯函数优先）：
- `sortEntries`：
  - `name` 升序、`edited` mtime 倒序、`created` birthtime 倒序；时间相等回退名字。
  - 非置顶组"文件夹优先"保持。
  - 置顶组按 `pinned` 数组序在最前；`pinned` 含本目录不存在的名字被忽略；置顶组不受 `sort`/文件夹优先影响。
- `parsePinned(text)` 纯解析容错：缺文件/坏 JSON/非数组→[]、正常→string 数组。
- `applyNotesOnly`：notesOnly=false 原样返回；true 时只留文件夹 + `hasNote`，丢弃纯文件与 `isOutlineNote`。

手动 / GUI（[[feedback_no_ui_automation_user_tests]]）：
1. 默认排序为最后编辑时间（新→旧）；切"名称""创建时间倒序"即时生效、全局一致。
2. 右键文件/文件夹→置顶：浮到该目录顶部；目录下出现 `.notemd.json`（仅此时）。
3. 取消该目录最后一个置顶 → `.notemd.json` 消失。
4. 置顶多项：顺序为置顶先后（手动序）。
5. 排序设置重启后保留（settings.json）。

## 已决策 / 权衡

- 排序**全局**（用户明确）：不为排序写任何 per-folder 文件。
- 置顶可作用于**文件+文件夹**（用户选择）。
- 置顶组内**按置顶顺序/手动**（用户选择），不套排序键。
- 时间排序均**倒序**（新→旧），名称升序。
- `.notemd.json` **仅置顶时存在**，空则删除（贴合"少写盘/默认不自动创建"）。
- 「只显示有笔记的 md」为**渲染层过滤**（不改缓存、不写盘）；口径 = `hasNote`（有配对笔记的主文档），独立 `.note.md` 与纯文件均隐藏，文件夹保留导航（不做子树判空，空文件夹仍显示——换取零子树扫描）。默认关，状态存 settings.json。
