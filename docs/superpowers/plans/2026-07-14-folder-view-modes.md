# 文件夹视图 视图模式 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 folder-view 的内容过滤收成单选 `viewMode`（all/files/withNotes/markdown/notes），新增"只看 markdown"（H1 当名、去后缀、留 ✦ 角标）和"只看笔记"（列全部 .note.md、去后缀名）。

**Architecture:** 过滤/显示名抽成纯函数（`filterByViewMode`/`displayNameFor`/`parseFirstH1`/`stripExt`/`stripNoteSuffix`）单测；`notesOnly`/`filesOnly` 布尔换成 `viewMode` 枚举（含旧设置迁移）；markdown 模式 H1 用 `titleCache` 惰性读+mtime 缓存；只改可见 label，重命名/置顶用真实文件名。

**Tech Stack:** Svelte 5 runes、Tauri plugin-fs、plugin-store、vitest、i18n(en/zh/de/ja)。

参考 spec：`docs/superpowers/specs/2026-07-14-folder-view-modes-design.md`

---

## 文件结构

- Modify `src/lib/folder-view.svelte.ts` — 加 `FolderViewMode`/`DEFAULT_VIEW_MODE`、`stripExt`/`stripNoteSuffix`/`parseFirstH1`/`filterByViewMode`/`displayNameFor`；删 `applyNotesOnly`/`applyFilesOnly`/`setNotesOnly`/`setFilesOnly`/`notesOnly`/`filesOnly`；加 `viewMode`/`titleCache` state、`setViewMode`/`ensureTitle`、load 迁移。
- Modify `src/lib/folder-view.test.ts` — 换纯函数测试；`setSort/setNotesOnly` describe 改 `setViewMode`。
- Modify `src/components/FolderView.svelte` — 排序菜单五个视图模式单选替换两复选框；`rootEntries` 用 `filterByViewMode`。
- Modify `src/components/FolderTreeNode.svelte` — `children` 用 `filterByViewMode`；label 用 `displayNameFor`；H1 惰性 `$effect`；notes 模式打开 notePath。
- Modify `src/lib/i18n/{en,zh,de,ja}.ts` — `folderView.view*` 键（复用旧 notesOnly/filesOnly 文案）。

---

## Task 1: 纯函数 filterByViewMode / displayNameFor / parseFirstH1 / stripExt / stripNoteSuffix

**Files:**
- Modify: `src/lib/folder-view.svelte.ts`
- Test: `src/lib/folder-view.test.ts`

- [ ] **Step 1: 写失败测试**

先把 test 顶部 import 从 `applyNotesOnly, applyFilesOnly` 换成新函数：

```ts
  pairNoteEntries, parsePinned,
  filterByViewMode, displayNameFor, parseFirstH1, stripExt, stripNoteSuffix,
} from './folder-view.svelte'
```

删除现有 `describe('applyNotesOnly'...)` 与 `describe('applyFilesOnly'...)` 两个块，替换为：

```ts
describe('stripExt / stripNoteSuffix', () => {
  it('stripExt removes markdown extensions', () => {
    expect(stripExt('a.md')).toBe('a')
    expect(stripExt('B.Markdown')).toBe('B')
    expect(stripExt('note')).toBe('note')
  })
  it('stripNoteSuffix removes .note.md / .notes.md', () => {
    expect(stripNoteSuffix('foo.note.md')).toBe('foo')
    expect(stripNoteSuffix('bar.notes.md')).toBe('bar')
    expect(stripNoteSuffix('plain.md')).toBe('plain.md')
  })
})

describe('parseFirstH1', () => {
  it('returns first H1 text', () => {
    expect(parseFirstH1('intro\n# Title Here\n## sub\n')).toBe('Title Here')
  })
  it('null when no H1; front-matter keys are not headings', () => {
    expect(parseFirstH1('no heading here')).toBeNull()
    expect(parseFirstH1('---\ntitle: x\n---\nbody')).toBeNull()
  })
})

describe('filterByViewMode', () => {
  const rows: FolderEntry[] = [
    { name: 'dir', path: '/d/dir', isDir: true, kind: null },
    { name: 'has.md', path: '/d/has.md', isDir: false, kind: 'markdown', hasNote: true, notePath: '/d/has.note.md' },
    { name: 'plain.md', path: '/d/plain.md', isDir: false, kind: 'markdown' },
    { name: 'pic.png', path: '/d/pic.png', isDir: false, kind: 'image' },
    { name: 'solo.note.md', path: '/d/solo.note.md', isDir: false, kind: 'markdown', isOutlineNote: true },
  ]
  const names = (m: Parameters<typeof filterByViewMode>[1]) => filterByViewMode(rows, m).map((e) => e.name)
  it('all → unchanged', () => { expect(filterByViewMode(rows, 'all')).toHaveLength(5) })
  it('files → hide folders', () => { expect(names('files')).toEqual(['has.md', 'plain.md', 'pic.png', 'solo.note.md']) })
  it('withNotes → folders + hasNote', () => { expect(names('withNotes')).toEqual(['dir', 'has.md']) })
  it('markdown → folders + markdown kind', () => { expect(names('markdown')).toEqual(['dir', 'has.md', 'plain.md', 'solo.note.md']) })
  it('notes → folders + notes (independent + hasNote)', () => { expect(names('notes')).toEqual(['dir', 'has.md', 'solo.note.md']) })
})

describe('displayNameFor', () => {
  const has: FolderEntry = { name: 'has.md', path: '/d/has.md', isDir: false, kind: 'markdown', hasNote: true, notePath: '/d/has.note.md' }
  const solo: FolderEntry = { name: 'solo.note.md', path: '/d/solo.note.md', isDir: false, kind: 'markdown', isOutlineNote: true }
  it('markdown: H1 title else filename without ext', () => {
    expect(displayNameFor(has, 'markdown', 'My Title')).toBe('My Title')
    expect(displayNameFor(has, 'markdown', null)).toBe('has')
  })
  it('notes: strip suffix (independent via note-suffix, hasNote via ext)', () => {
    expect(displayNameFor(solo, 'notes')).toBe('solo')
    expect(displayNameFor(has, 'notes')).toBe('has')
  })
  it('other modes: raw name', () => {
    expect(displayNameFor(has, 'all')).toBe('has.md')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/folder-view.test.ts`
Expected: FAIL —— 新函数未定义 / 旧函数已被 import 移除。

- [ ] **Step 3: 实现**（`folder-view.svelte.ts`）

删掉现有 `applyNotesOnly` 与 `applyFilesOnly` 两个函数，替换为：

```ts
export type FolderViewMode = 'all' | 'files' | 'withNotes' | 'markdown' | 'notes'
export const DEFAULT_VIEW_MODE: FolderViewMode = 'all'

const EXT_RE = /\.(md|markdown|mdown|mkd)$/i

/** 去 markdown 扩展名（无匹配原样返回）。 */
export function stripExt(name: string): string {
  return name.replace(EXT_RE, '')
}
/** 去伴生笔记后缀 .note.md / .notes.md（无匹配原样返回）。 */
export function stripNoteSuffix(name: string): string {
  return name.replace(/\.notes?\.md$/i, '')
}
/** 取正文第一个一级标题 `# xxx`；无则 null。front-matter 的 key 不会误判(不以 # 开头)。 */
export function parseFirstH1(text: string): string | null {
  const m = text.match(/^#\s+(.+?)\s*$/m)
  return m ? m[1] : null
}

/** 按视图模式过滤条目（markdown/notes 保留文件夹供导航；files 隐藏文件夹）。 */
export function filterByViewMode(entries: FolderEntry[], mode: FolderViewMode): FolderEntry[] {
  switch (mode) {
    case 'files': return entries.filter((e) => !e.isDir)
    case 'withNotes': return entries.filter((e) => e.isDir || e.hasNote === true)
    case 'markdown': return entries.filter((e) => e.isDir || e.kind === 'markdown')
    case 'notes': return entries.filter((e) => e.isDir || e.isOutlineNote === true || e.hasNote === true)
    default: return entries
  }
}

/** 视图模式下的显示名（只改可见文字）。markdown=H1/去扩展；notes=去后缀。 */
export function displayNameFor(entry: FolderEntry, mode: FolderViewMode, title?: string | null): string {
  if (entry.isDir) return entry.name
  if (mode === 'markdown') return title && title.length ? title : stripExt(entry.name)
  if (mode === 'notes') {
    if (entry.isOutlineNote) return stripNoteSuffix(entry.name)
    if (entry.hasNote) return stripExt(entry.name)
  }
  return entry.name
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/folder-view.test.ts -t "filterByViewMode|displayNameFor|parseFirstH1|strip"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/folder-view.svelte.ts src/lib/folder-view.test.ts
git commit -m "feat(folder-view): view-mode filter + display-name pure helpers"
```

---

## Task 2: state viewMode + titleCache + setViewMode/ensureTitle + 迁移

**Files:**
- Modify: `src/lib/folder-view.svelte.ts`
- Test: `src/lib/folder-view.test.ts`

- [ ] **Step 1: 改 store 测试**

把现有 `describe('setSort / setNotesOnly', ...)` 块整体替换为：

```ts
describe('setSort / setViewMode', () => {
  it('setSort re-sorts cached dirs and persists', async () => {
    folderView.entriesCache.set('/r', [
      { name: 'a.md', path: '/r/a.md', isDir: false, kind: 'markdown', mtime: 1 },
      { name: 'b.md', path: '/r/b.md', isDir: false, kind: 'markdown', mtime: 9 },
    ])
    await setSort('edited')
    expect(folderView.entriesCache.get('/r')!.map((e) => e.name)).toEqual(['b.md', 'a.md'])
    expect(storeSet).toHaveBeenCalledWith('folderView.sort', 'edited')
  })
  it('setViewMode persists', async () => {
    await setViewMode('markdown')
    expect(folderView.viewMode).toBe('markdown')
    expect(storeSet).toHaveBeenCalledWith('folderView.viewMode', 'markdown')
  })
})
```

顶部 import 把 `setSort, setNotesOnly` 改为 `setSort, setViewMode`。`beforeEach` 里把 `folderView.notesOnly=...`/`filesOnly` 相关重置行（若有）改为 `folderView.viewMode = 'all'`；并补 `folderView.titleCache = new SvelteMap()`（若 beforeEach 重置了 entriesCache，同样重置 titleCache）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/folder-view.test.ts -t setViewMode`
Expected: FAIL —— `setViewMode`/`viewMode` 未定义。

- [ ] **Step 3: 实现**（`folder-view.svelte.ts`）

`FolderViewState` 接口：删 `notesOnly`/`filesOnly`，加：

```ts
  sort: FolderSortKey
  /** 单选视图模式（存 settings.json） */
  viewMode: FolderViewMode
  /** markdown 模式 H1 惰性缓存：path → { mtime, title|null } */
  titleCache: SvelteMap<string, { mtime: number; title: string | null }>
```

`folderView = $state({...})`：删 `notesOnly:false, filesOnly:false`，加：

```ts
  sort: DEFAULT_SORT,
  viewMode: DEFAULT_VIEW_MODE,
  titleCache: new SvelteMap(),
```

删 `setNotesOnly`/`setFilesOnly`，加：

```ts
/** 设置单选视图模式（渲染过滤，不重读盘）。 */
export async function setViewMode(mode: FolderViewMode): Promise<void> {
  folderView.viewMode = mode
  const s = await getStore()
  await s.set('folderView.viewMode', mode)
  await s.save()
}

/** markdown 模式惰性读某 md 的首个 H1 → titleCache（按 mtime 去重）。 */
export async function ensureTitle(entry: FolderEntry): Promise<void> {
  const mtime = entry.mtime ?? 0
  const cached = folderView.titleCache.get(entry.path)
  if (cached && cached.mtime === mtime) return
  let title: string | null = null
  try {
    title = parseFirstH1(await readTextFile(entry.path))
  } catch { title = null }
  folderView.titleCache.set(entry.path, { mtime, title })
}
```

`loadFolderViewState` 里把读 `notesOnly`/`filesOnly` 两行替换为 viewMode（含旧键迁移）：

```ts
  const savedSort = await s.get<string>('folderView.sort')
  folderView.sort = savedSort === 'name' || savedSort === 'created' || savedSort === 'edited' ? savedSort : DEFAULT_SORT
  const savedMode = await s.get<string>('folderView.viewMode')
  if (savedMode && ['all', 'files', 'withNotes', 'markdown', 'notes'].includes(savedMode)) {
    folderView.viewMode = savedMode as FolderViewMode
  } else if (await s.get<boolean>('folderView.filesOnly')) {
    folderView.viewMode = 'files'
  } else if (await s.get<boolean>('folderView.notesOnly')) {
    folderView.viewMode = 'withNotes'
  } else {
    folderView.viewMode = DEFAULT_VIEW_MODE
  }
```

需确保顶部 `import { SvelteMap } ...` 已有（文件已用 SvelteMap）。`readTextFile` 已在 plugin-fs import 内（Task 前序已加）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/folder-view.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 提交**

```bash
git add src/lib/folder-view.svelte.ts src/lib/folder-view.test.ts
git commit -m "feat(folder-view): viewMode state + titleCache + setViewMode/ensureTitle (migrate booleans)"
```

---

## Task 3: i18n view* 键

**Files:**
- Modify: `src/lib/i18n/{en,zh,de,ja}.ts`

复用旧 `notesOnly`/`filesOnly` 文案；保留旧键（避免其它引用报错），新增 view* 键。

- [ ] **Step 1: en.ts**（`'folderView.filesOnly'` 行后）

```ts
  'folderView.viewAll': 'All',
  'folderView.viewFiles': 'Only files',
  'folderView.viewWithNotes': 'Files with notes',
  'folderView.viewMarkdown': 'Markdown only',
  'folderView.viewNotes': 'Notes only',
```

- [ ] **Step 2: zh.ts**

```ts
  'folderView.viewAll': '全部',
  'folderView.viewFiles': '只显示文件',
  'folderView.viewWithNotes': '只显示有笔记的文件',
  'folderView.viewMarkdown': '只看 Markdown',
  'folderView.viewNotes': '只看笔记',
```

- [ ] **Step 3: de.ts**

```ts
  'folderView.viewAll': 'Alle',
  'folderView.viewFiles': 'Nur Dateien',
  'folderView.viewWithNotes': 'Dateien mit Notizen',
  'folderView.viewMarkdown': 'Nur Markdown',
  'folderView.viewNotes': 'Nur Notizen',
```

- [ ] **Step 4: ja.ts**

```ts
  'folderView.viewAll': 'すべて',
  'folderView.viewFiles': 'ファイルのみ',
  'folderView.viewWithNotes': 'ノートのあるファイル',
  'folderView.viewMarkdown': 'Markdown のみ',
  'folderView.viewNotes': 'ノートのみ',
```

- [ ] **Step 5: check + 提交**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -c Error`
Expected: `0`（i18n 本身；组件引用在 Task 4/5 更新前可能暂报错——若报错是 FolderView/FolderTreeNode 引用旧函数，属预期，Task 4/5 修）

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/de.ts src/lib/i18n/ja.ts
git commit -m "feat(folder-view): i18n for view modes"
```

---

## Task 4: FolderView.svelte —— 视图模式单选替换两复选框

**Files:**
- Modify: `src/components/FolderView.svelte`

- [ ] **Step 1: 改 import**

把 folder-view import 里的 `setNotesOnly, setFilesOnly, togglePin, applyNotesOnly, applyFilesOnly` 换成 `setViewMode, togglePin, filterByViewMode`，并把 `type FolderSortKey` 旁加 `type FolderViewMode`：

```ts
    setSort, setViewMode, togglePin, filterByViewMode,
    type FolderEntry, type FolderSortKey, type FolderViewMode,
  } from '../lib/folder-view.svelte'
```

- [ ] **Step 2: rootEntries 用 filterByViewMode**

```ts
  let rootEntries = $derived.by<FolderEntry[]>(() => {
    const all = folderView.rootDir ? (folderView.entriesCache.get(folderView.rootDir) ?? []) : []
    const filtered = filtering ? all.filter((e) => folderView.filterVisible.has(e.path)) : all
    return filterByViewMode(filtered, folderView.viewMode)
  })
```

- [ ] **Step 3: 替换 toggle 处理器 + 视图选项常量**

删 `toggleNotesOnly`/`toggleFilesOnly`，加：

```ts
  const VIEW_OPTS: { mode: FolderViewMode; label: Parameters<typeof t>[0] }[] = [
    { mode: 'all', label: 'folderView.viewAll' },
    { mode: 'files', label: 'folderView.viewFiles' },
    { mode: 'withNotes', label: 'folderView.viewWithNotes' },
    { mode: 'markdown', label: 'folderView.viewMarkdown' },
    { mode: 'notes', label: 'folderView.viewNotes' },
  ]
  async function pickView(mode: FolderViewMode) { closeSortMenu(); await setViewMode(mode) }
```

- [ ] **Step 4: 排序按钮高亮条件**

```svelte
    <button class="hbtn sort-btn" class:on={sortMenu.open || folderView.viewMode !== 'all' || folderView.sort !== 'edited'} onclick={toggleSortMenu} title={t('folderView.sortBy')} aria-label={t('folderView.sortBy')}>
```

- [ ] **Step 5: 菜单里两复选框换成五个视图单选**

把 `.sort-menu` 里 `<div class="sort-sep">` 之后的两个 `menuitemcheckbox` 按钮整体替换为：

```svelte
    <div class="sort-sep"></div>
    {#each VIEW_OPTS as opt (opt.mode)}
      <button type="button" role="menuitemradio" aria-checked={folderView.viewMode === opt.mode}
        class="node-ctx-item menu-row" onclick={() => void pickView(opt.mode)}>
        <span class="check">{folderView.viewMode === opt.mode ? '✓' : ''}</span>{t(opt.label)}
      </button>
    {/each}
```

- [ ] **Step 6: check 通过**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep "FolderView.svelte" | grep -i error || echo clean`
Expected: `clean`

- [ ] **Step 7: 提交**

```bash
git add src/components/FolderView.svelte
git commit -m "feat(folder-view): single-select view mode menu (replaces filter checkboxes)"
```

---

## Task 5: FolderTreeNode.svelte —— 显示名 + H1 惰性 + notes 打开目标

**Files:**
- Modify: `src/components/FolderTreeNode.svelte`

- [ ] **Step 1: 改 import**

```ts
  import { folderView, toggleExpanded, filterByViewMode, displayNameFor, ensureTitle, type FolderEntry } from '../lib/folder-view.svelte'
```

- [ ] **Step 2: children 用 filterByViewMode**

```ts
  let children = $derived.by<FolderEntry[]>(() => {
    const all = folderView.entriesCache.get(entry.path) ?? []
    const filtered = filtering ? all.filter((c) => folderView.filterVisible.has(c.path)) : all
    return filterByViewMode(filtered, folderView.viewMode)
  })
```

- [ ] **Step 3: 显示名 derived + H1 惰性 effect**

在 `let isActive = ...` 附近加：

```ts
  let label = $derived(displayNameFor(entry, folderView.viewMode, folderView.titleCache.get(entry.path)?.title))
  // markdown 模式：对可见 md 行惰性读 H1（按 mtime 缓存，改了才重读）
  $effect(() => {
    if (folderView.viewMode !== 'markdown' || entry.isDir || entry.kind !== 'markdown') return
    const c = folderView.titleCache.get(entry.path)
    if (c && c.mtime === (entry.mtime ?? 0)) return
    void ensureTitle(entry)
  })
```

- [ ] **Step 4: label 替换 + notes 打开目标**

模板里 `<span class="label">{entry.name}</span>` 改为 `<span class="label">{label}</span>`。

`onRowClick` 改为按 notes 模式打开笔记：

```ts
  function onRowClick() {
    if (entry.isDir) { toggleExpanded(entry.path); return }
    const target = folderView.viewMode === 'notes' && entry.hasNote && entry.notePath ? entry.notePath : entry.path
    onOpen(target)
  }
```

（`title={entry.name}` 悬浮、重命名 input `value={entry.name}`、✦ 角标 `entry.hasNote && entry.notePath` 段均**不动**——真实文件名/角标照旧。）

- [ ] **Step 5: check 通过**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep "FolderTreeNode" | grep -i error || echo clean`
Expected: `clean`

- [ ] **Step 6: 提交**

```bash
git add src/components/FolderTreeNode.svelte
git commit -m "feat(folder-view): display H1/stripped names + lazy H1 read + notes open target"
```

---

## Task 6: 全量 check + test

- [ ] **Step 1: 单元测试**

Run: `pnpm test`
Expected: 全绿。

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 0 error。

- [ ] **Step 3: 失败按 systematic-debugging 修复后重跑**

---

## Task 7: dev GUI 实机验证（人工）

遵循 [[feedback_no_ui_automation_user_tests]]。

- [ ] **Step 1: 起 dev**

Run: `pnpm tauri dev`

- [ ] **Step 2: 验收**

1. 排序菜单里视图模式是单选（全部/只显示文件/只显示有笔记的文件/只看 Markdown/只看笔记），切换即时、重启保留；旧的两复选框已并入；升级后旧的 notesOnly/filesOnly 设置被迁移。
2. 只看 Markdown：只剩 md（+文件夹可展开）；行名显示 H1 标题、无后缀；无 H1 的 md 用文件名；主文档 ✦ 角标仍在后面。
3. 只看笔记：只剩 .note.md（+文件夹）；名字去后缀；配对笔记也列出且点开对应 .note.md。
4. 文件夹可钻取子目录，子目录同样按模式过滤。

---

## Self-Review 记录

- **Spec 覆盖**：单选 viewMode+迁移→Task 2；五模式过滤→Task 1(filterByViewMode)；markdown H1/去后缀→Task 1(displayNameFor)+Task 2(ensureTitle/titleCache)+Task 5(effect/label)；notes 全部笔记+去后缀+打开→Task 1+Task 5；✦ 角标保留→Task 5(不动该段)；菜单单选→Task 4；i18n→Task 3。全覆盖。
- **占位符**：无 TBD/TODO；每步给完整代码。
- **类型一致**：`FolderViewMode`('all'|'files'|'withNotes'|'markdown'|'notes')、`filterByViewMode`/`displayNameFor`/`parseFirstH1`/`stripExt`/`stripNoteSuffix`/`setViewMode`/`ensureTitle`/`titleCache({mtime,title})` 定义与调用一致；删除的 applyNotesOnly/applyFilesOnly/setNotesOnly/setFilesOnly 在 Task 4/5 同步移除所有引用。
- **风险**：markdown 模式对每个可见 md 读文件取 H1——惰性(仅该模式)+mtime 缓存，滚动可见行才读；`ensureTitle` 读整文件(md 通常小)；notes 模式 hasNote 行 label 用去后缀名、点开 notePath，但置顶/重命名仍作用于真实主文档 entry(接受)；旧 i18n notesOnly/filesOnly 键保留避免悬空引用。
