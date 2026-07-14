# 文件夹视图 排序 + 置顶 + 只显示有笔记 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件夹视图加三种全局排序（默认最后编辑时间）、per-folder 置顶（`.notemd.json`，默认不自动创建）、以及"只显示有笔记的 md"过滤复选框。

**Architecture:** 排序/过滤逻辑抽成纯函数（`sortEntries`/`parsePinned`/`applyNotesOnly`）在 folder-view.svelte.ts 单测；`readFolder` 补 `stat`(mtime/birthtime)+读 `.notemd.json`；排序与"只显示有笔记"是全局设置存 settings.json；置顶写 per-folder `.notemd.json`（空则删）。UI 在 FolderView 工具栏加排序菜单、右键加置顶、FolderTreeNode 加图钉角标。

**Tech Stack:** Svelte 5 runes、Tauri plugin-fs（readDir/stat/exists/readTextFile/writeTextFile/remove）、plugin-store（settings.json）、vitest、自研 i18n（en/zh/de/ja）。

参考 spec：`docs/superpowers/specs/2026-07-14-folder-view-sort-and-pin-design.md`

---

## 文件结构

- Modify `src/lib/folder-view.svelte.ts` — `FolderEntry` 加 `mtime/birthtime/pinned`；`FolderSortKey`/`DEFAULT_SORT`；重写 `sortEntries`；新增 `parsePinned`/`applyNotesOnly`/`readPinned`/`togglePin`/`setSort`/`setNotesOnly`；`readFolder` 补 stat+pins；state 加 `sort/notesOnly`；load 读取。
- Modify `src/lib/folder-view.test.ts` — 新签名 `sortEntries` 测试 + `parsePinned`/`applyNotesOnly` 测试；plugin-fs mock 补 stat/exists/readTextFile。
- Modify `src/components/FolderView.svelte` — 排序菜单按钮+菜单（3 排序+复选框）、右键置顶项、`rootEntries` 套 `applyNotesOnly`。
- Modify `src/components/FolderTreeNode.svelte` — 图钉角标、children 套 `applyNotesOnly`。
- Modify `src/lib/i18n/{en,zh,de,ja}.ts` — 7 个 `folderView.*` 键。

---

## Task 1: 纯函数 sortEntries 新签名 + 类型 + FolderEntry 字段

**Files:**
- Modify: `src/lib/folder-view.svelte.ts`
- Test: `src/lib/folder-view.test.ts`

- [ ] **Step 1: 写失败测试**

在 `folder-view.test.ts` 现有 `describe('sortEntries', ...)`（约 line 224）**之前**先把旧调用适配，再追加新用例。先改旧用例（line ~232）`sortEntries(input)` → `sortEntries(input, 'name', [])`。然后在该 describe 后追加：

```ts
function ent(name: string, over: Partial<FolderEntry> = {}): FolderEntry {
  return { name, path: '/d/' + name, isDir: false, kind: 'markdown', ...over }
}

describe('sortEntries sort keys + pinning', () => {
  it('name: folders first then name asc', () => {
    const input = [ent('b.md'), ent('dir', { isDir: true, kind: null }), ent('a.md')]
    expect(sortEntries(input, 'name', []).map(e => e.name)).toEqual(['dir', 'a.md', 'b.md'])
  })
  it('edited: mtime desc, tie→name', () => {
    const input = [ent('a.md', { mtime: 10 }), ent('b.md', { mtime: 30 }), ent('c.md', { mtime: 30 })]
    expect(sortEntries(input, 'edited', []).map(e => e.name)).toEqual(['b.md', 'c.md', 'a.md'])
  })
  it('created: birthtime desc', () => {
    const input = [ent('a.md', { birthtime: 5 }), ent('b.md', { birthtime: 50 })]
    expect(sortEntries(input, 'created', []).map(e => e.name)).toEqual(['b.md', 'a.md'])
  })
  it('pinned group first in array order, rest sorted; missing pins ignored', () => {
    const input = [ent('a.md', { mtime: 1 }), ent('b.md', { mtime: 9 }), ent('c.md', { mtime: 5 })]
    const out = sortEntries(input, 'edited', ['c.md', 'ghost.md', 'a.md']).map(e => e.name)
    expect(out).toEqual(['c.md', 'a.md', 'b.md'])   // 置顶 c,a 按数组序；余 b
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/folder-view.test.ts`
Expected: FAIL —— `sortEntries` 参数不匹配 / 新用例失败。

- [ ] **Step 3: 实现**

`folder-view.svelte.ts`：`FolderEntry` 接口加字段（`notePath?` 行后）：

```ts
  notePath?: string
  /** 最后修改(ms)，stat 失败为 0 */
  mtime?: number
  /** 创建(ms)，stat 失败为 0 */
  birthtime?: number
  /** 名字 ∈ 本目录 .notemd.json pinned 集 */
  pinned?: boolean
```

在 `sortEntries` 上方加类型：

```ts
export type FolderSortKey = 'edited' | 'name' | 'created'
export const DEFAULT_SORT: FolderSortKey = 'edited'
```

用下面整体替换现有 `sortEntries`（line 118-124）：

```ts
/**
 * 排序：置顶组(按 pinned 数组序)在最前；其余"文件夹优先"，组内按 sort
 * (name 升序 / edited=mtime 倒序 / created=birthtime 倒序，时间相等回退名字)。
 */
export function sortEntries(entries: FolderEntry[], sort: FolderSortKey, pinned: string[]): FolderEntry[] {
  const byName = (a: FolderEntry, b: FolderEntry) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  const pinnedSet = new Set(pinned)
  const byNameMap = new Map(entries.map((e) => [e.name, e]))
  const pinnedGroup = pinned
    .map((n) => byNameMap.get(n))
    .filter((e): e is FolderEntry => !!e)
  const rest = entries.filter((e) => !pinnedSet.has(e.name))
  rest.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    if (sort === 'name') return byName(a, b)
    if (sort === 'edited') return ((b.mtime ?? 0) - (a.mtime ?? 0)) || byName(a, b)
    return ((b.birthtime ?? 0) - (a.birthtime ?? 0)) || byName(a, b)
  })
  return [...pinnedGroup, ...rest]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/folder-view.test.ts -t sortEntries`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/folder-view.svelte.ts src/lib/folder-view.test.ts
git commit -m "feat(folder-view): sortEntries with sort key + pinned group"
```

---

## Task 2: 纯函数 parsePinned

**Files:**
- Modify: `src/lib/folder-view.svelte.ts`
- Test: `src/lib/folder-view.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `folder-view.test.ts`；顶部 import 补 `parsePinned`）

```ts
describe('parsePinned', () => {
  it('parses a valid pinned array of strings', () => {
    expect(parsePinned('{"pinned":["a.md","dir"]}')).toEqual(['a.md', 'dir'])
  })
  it('bad json / missing / non-array / non-strings → []', () => {
    expect(parsePinned('not json')).toEqual([])
    expect(parsePinned('{}')).toEqual([])
    expect(parsePinned('{"pinned":"x"}')).toEqual([])
    expect(parsePinned('{"pinned":[1,"ok",null]}')).toEqual(['ok'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/folder-view.test.ts -t parsePinned`
Expected: FAIL —— `parsePinned` 未定义。

- [ ] **Step 3: 实现**（`folder-view.svelte.ts`，`sortEntries` 附近）

```ts
export const PINNED_FILE = '.notemd.json'

/** 解析 .notemd.json 文本 → 置顶名字数组；任何异常/非法结构 → []。 */
export function parsePinned(text: string): string[] {
  try {
    const arr = (JSON.parse(text) as { pinned?: unknown })?.pinned
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/folder-view.test.ts -t parsePinned`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/folder-view.svelte.ts src/lib/folder-view.test.ts
git commit -m "feat(folder-view): parsePinned (.notemd.json) with tolerant parsing"
```

---

## Task 3: 纯函数 applyNotesOnly

**Files:**
- Modify: `src/lib/folder-view.svelte.ts`
- Test: `src/lib/folder-view.test.ts`

- [ ] **Step 1: 写失败测试**（追加；顶部 import 补 `applyNotesOnly`）

```ts
describe('applyNotesOnly', () => {
  const rows: FolderEntry[] = [
    { name: 'dir', path: '/d/dir', isDir: true, kind: null },
    { name: 'has.md', path: '/d/has.md', isDir: false, kind: 'markdown', hasNote: true, notePath: '/d/has.note.md' },
    { name: 'plain.md', path: '/d/plain.md', isDir: false, kind: 'markdown' },
    { name: 'solo.note.md', path: '/d/solo.note.md', isDir: false, kind: 'markdown', isOutlineNote: true },
  ]
  it('false → unchanged', () => {
    expect(applyNotesOnly(rows, false)).toHaveLength(4)
  })
  it('true → keep folders + hasNote only', () => {
    expect(applyNotesOnly(rows, true).map(e => e.name)).toEqual(['dir', 'has.md'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/folder-view.test.ts -t applyNotesOnly`
Expected: FAIL —— 未定义。

- [ ] **Step 3: 实现**（`folder-view.svelte.ts`）

```ts
/** 「只显示有笔记的 md」渲染过滤：保留文件夹 + 有配对笔记(hasNote)的主文档。 */
export function applyNotesOnly(entries: FolderEntry[], notesOnly: boolean): FolderEntry[] {
  if (!notesOnly) return entries
  return entries.filter((e) => e.isDir || e.hasNote === true)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/folder-view.test.ts -t applyNotesOnly`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/folder-view.svelte.ts src/lib/folder-view.test.ts
git commit -m "feat(folder-view): applyNotesOnly render filter"
```

---

## Task 4: readFolder stat+pins、pins IO、全局设置、state

**Files:**
- Modify: `src/lib/folder-view.svelte.ts`
- Modify: `src/lib/folder-view.test.ts`（补 plugin-fs mock，避免现有 readFolder 测试因新 fs 调用而崩）

- [ ] **Step 1: 扩展 plugin-fs mock**

`folder-view.test.ts` 顶部 mock 块替换为：

```ts
const readDirMock = vi.fn()
const statMock = vi.fn(async () => ({ mtime: new Date(0), birthtime: new Date(0) }))
const existsMock = vi.fn(async () => false)
const readTextFileMock = vi.fn(async () => '')
const writeTextFileMock = vi.fn(async () => {})
const removeMock = vi.fn(async () => {})
vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: (...a: unknown[]) => readDirMock(...a),
  stat: (...a: unknown[]) => statMock(...a),
  exists: (...a: unknown[]) => existsMock(...a),
  readTextFile: (...a: unknown[]) => readTextFileMock(...a),
  writeTextFile: (...a: unknown[]) => writeTextFileMock(...a),
  remove: (...a: unknown[]) => removeMock(...a),
  watchImmediate: vi.fn(async () => () => {}),
}))
```

并在 `beforeEach` 里补重置：

```ts
  readDirMock.mockReset()
  statMock.mockReset(); statMock.mockResolvedValue({ mtime: new Date(0), birthtime: new Date(0) })
  existsMock.mockReset(); existsMock.mockResolvedValue(false)
  readTextFileMock.mockReset(); readTextFileMock.mockResolvedValue('')
```

- [ ] **Step 2: 跑现有测试确认仍需实现**

Run: `npx vitest run src/lib/folder-view.test.ts`
Expected: 现有 readFolder 测试通过或因 import 缺失报错（下一步补齐）。

- [ ] **Step 3: 实现 folder-view.svelte.ts**

顶部 import 改为：

```ts
import { readDir, watchImmediate, stat, exists, readTextFile, writeTextFile, remove } from '@tauri-apps/plugin-fs'
```

state 默认值加字段（`folderView = $state({...})`）：

```ts
  entriesCache: new SvelteMap(),
  sort: DEFAULT_SORT,
  notesOnly: false,
```

`FolderViewState` 接口加：

```ts
  entriesCache: SvelteMap<string, FolderEntry[]>
  sort: FolderSortKey
  notesOnly: boolean
```

`readPinned`/`togglePin`（放 `revealInFinder` 附近）：

```ts
/** 读本目录 .notemd.json → 置顶名字数组；无文件/异常 → []（绝不创建）。 */
export async function readPinned(dir: string): Promise<string[]> {
  const path = joinPath(dir, PINNED_FILE)
  if (!(await exists(path).catch(() => false))) return []
  return parsePinned(await readTextFile(path).catch(() => ''))
}

/** 切换置顶：读→改→写；结果空则删文件；随后重读本目录刷新缓存。 */
export async function togglePin(dir: string, name: string): Promise<void> {
  const path = joinPath(dir, PINNED_FILE)
  const cur = await readPinned(dir)
  const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]
  if (next.length === 0) {
    if (await exists(path).catch(() => false)) await remove(path).catch(() => {})
  } else {
    await writeTextFile(path, JSON.stringify({ pinned: next }, null, 2) + '\n').catch(() => {})
  }
  await readFolder(dir).catch(() => {})
}
```

用下面整体替换 `readFolder`（line 155-171）：

```ts
/** Read a directory: classify, stat(time), read pins, mark, sort, cache. */
export async function readFolder(dir: string): Promise<FolderEntry[]> {
  const raw = await readDir(dir)
  const base: FolderEntry[] = raw
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const path = joinPath(dir, e.name)
      return {
        name: e.name,
        path,
        isDir: !!e.isDirectory,
        kind: e.isDirectory ? null : (classifyPath(path)?.kind ?? null),
      }
    })
  await Promise.all(base.map(async (en) => {
    const st = await stat(en.path).catch(() => null)
    en.mtime = st?.mtime ? new Date(st.mtime).getTime() : 0
    en.birthtime = st?.birthtime ? new Date(st.birthtime).getTime() : 0
  }))
  const pinned = await readPinned(dir)
  const pinnedSet = new Set(pinned)
  const paired = pairNoteEntries(base).map((e) => (pinnedSet.has(e.name) ? { ...e, pinned: true } : e))
  const sorted = sortEntries(paired, folderView.sort, pinned)
  folderView.entriesCache.set(dir, sorted)
  return sorted
}
```

`setSort`/`setNotesOnly`（persistence 区，`setWidth` 附近）：

```ts
export async function setSort(key: FolderSortKey): Promise<void> {
  folderView.sort = key
  // 就地重排已缓存目录（时间元数据已在 entry 上，无需重读盘）
  for (const [dir, entries] of folderView.entriesCache) {
    const pinned = entries.filter((e) => e.pinned).map((e) => e.name)
    folderView.entriesCache.set(dir, sortEntries(entries, key, pinned))
  }
  const s = await getStore()
  await s.set('folderView.sort', key)
  await s.save()
}

export async function setNotesOnly(v: boolean): Promise<void> {
  folderView.notesOnly = v
  const s = await getStore()
  await s.set('folderView.notesOnly', v)
  await s.save()
}
```

`loadFolderViewState` 末尾补读取：

```ts
  folderView.width = (await s.get<number>('folderView.width')) ?? DEFAULT_WIDTH
  const savedSort = await s.get<string>('folderView.sort')
  folderView.sort = (savedSort === 'name' || savedSort === 'created' || savedSort === 'edited') ? savedSort : DEFAULT_SORT
  folderView.notesOnly = (await s.get<boolean>('folderView.notesOnly')) ?? false
```

- [ ] **Step 4: 加 readFolder pins/sort 集成测试**（追加到 test）

```ts
describe('readFolder pins + sort', () => {
  it('marks pinned entries and floats them first', async () => {
    readDirMock.mockResolvedValue([
      { name: 'a.md', isDirectory: false }, { name: 'b.md', isDirectory: false },
    ])
    existsMock.mockResolvedValue(true)
    readTextFileMock.mockResolvedValue('{"pinned":["b.md"]}')
    const out = await readFolder('/root')
    expect(out[0].name).toBe('b.md')
    expect(out[0].pinned).toBe(true)
  })
})
```

（顶部 import 补 `readPinned, togglePin, setSort, setNotesOnly`；`readFolder` 已在 import 内。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/lib/folder-view.test.ts`
Expected: PASS（全部）

- [ ] **Step 6: 提交**

```bash
git add src/lib/folder-view.svelte.ts src/lib/folder-view.test.ts
git commit -m "feat(folder-view): readFolder stat+pins, pin IO, global sort/notesOnly settings"
```

---

## Task 5: i18n（7 键 × 4 语言）

**Files:**
- Modify: `src/lib/i18n/en.ts`、`zh.ts`、`de.ts`、`ja.ts`

- [ ] **Step 1: en.ts**（`'folderView.rename'` 行后）

```ts
  'folderView.sortBy': 'Sort by',
  'folderView.sortEdited': 'Last edited',
  'folderView.sortName': 'Name',
  'folderView.sortCreated': 'Date created (newest)',
  'folderView.pin': 'Pin to top',
  'folderView.unpin': 'Unpin',
  'folderView.notesOnly': 'Only files with notes',
```

- [ ] **Step 2: zh.ts**

```ts
  'folderView.sortBy': '排序方式',
  'folderView.sortEdited': '最后编辑时间',
  'folderView.sortName': '名称',
  'folderView.sortCreated': '创建时间（最新）',
  'folderView.pin': '置顶',
  'folderView.unpin': '取消置顶',
  'folderView.notesOnly': '只显示有笔记的文件',
```

- [ ] **Step 3: de.ts**

```ts
  'folderView.sortBy': 'Sortieren nach',
  'folderView.sortEdited': 'Zuletzt bearbeitet',
  'folderView.sortName': 'Name',
  'folderView.sortCreated': 'Erstellt (neueste)',
  'folderView.pin': 'Anheften',
  'folderView.unpin': 'Lösen',
  'folderView.notesOnly': 'Nur Dateien mit Notizen',
```

- [ ] **Step 4: ja.ts**

```ts
  'folderView.sortBy': '並び替え',
  'folderView.sortEdited': '最終編集日時',
  'folderView.sortName': '名前',
  'folderView.sortCreated': '作成日時（新しい順）',
  'folderView.pin': 'ピン留め',
  'folderView.unpin': 'ピン留めを解除',
  'folderView.notesOnly': 'ノートのあるファイルのみ',
```

- [ ] **Step 5: check + 提交**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -c Error`
Expected: `0`

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/de.ts src/lib/i18n/ja.ts
git commit -m "feat(folder-view): i18n for sort menu, pin, notes-only"
```

---

## Task 6: FolderView UI —— 排序菜单 + 置顶右键 + notesOnly

**Files:**
- Modify: `src/components/FolderView.svelte`

- [ ] **Step 1: script 补 import 与状态/处理器**

`import { ... } from '../lib/folder-view.svelte'` 里补：`setSort, setNotesOnly, togglePin, applyNotesOnly, type FolderSortKey`。

`rootEntries` derived（line 32-35）改为再套 notesOnly：

```ts
  let rootEntries = $derived.by<FolderEntry[]>(() => {
    const all = folderView.rootDir ? (folderView.entriesCache.get(folderView.rootDir) ?? []) : []
    const filtered = filtering ? all.filter((e) => folderView.filterVisible.has(e.path)) : all
    return applyNotesOnly(filtered, folderView.notesOnly)
  })
```

`ctx`/rename 区之后新增排序菜单状态与置顶处理：

```ts
  // 排序菜单（fixed 定位，锚到按钮左下）
  let sortMenu = $state<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 })
  function toggleSortMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    sortMenu = sortMenu.open ? { open: false, x: 0, y: 0 } : { open: true, x: r.left, y: r.bottom + 2 }
  }
  function closeSortMenu() { sortMenu = { open: false, x: 0, y: 0 } }
  const SORT_OPTS: { key: FolderSortKey; label: string }[] = [
    { key: 'edited', label: 'folderView.sortEdited' },
    { key: 'name', label: 'folderView.sortName' },
    { key: 'created', label: 'folderView.sortCreated' },
  ]
  async function pickSort(key: FolderSortKey) { closeSortMenu(); await setSort(key) }
  async function toggleNotesOnly() { await setNotesOnly(!folderView.notesOnly) }

  async function pinCtx() {
    const entry = ctx.entry
    closeCtxMenu()
    if (!entry) return
    await togglePin(parentDir(entry.path), entry.name)
  }
```

`onWindowMouseDown` 里也关排序菜单：

```ts
  function onWindowMouseDown(e: MouseEvent) {
    const target = e.target as HTMLElement | null
    if (sortMenu.open && !target?.closest('.sort-menu') && !target?.closest('.sort-btn')) closeSortMenu()
    if (!ctx.open) return
    if (target?.closest('.node-ctx-menu')) return
    closeCtxMenu()
  }
```

`onWindowKeyDown` 里 Esc 也关排序菜单：

```ts
  function onWindowKeyDown(e: KeyboardEvent) {
    if (sortMenu.open && e.key === 'Escape') { e.preventDefault(); closeSortMenu() }
    if (ctx.open && e.key === 'Escape') { e.preventDefault(); closeCtxMenu() }
  }
```

- [ ] **Step 2: 工具栏加排序按钮**（在 refresh 按钮 `</button>`(line 149) 之后）

```svelte
    <button class="hbtn sort-btn" onclick={toggleSortMenu} title={t('folderView.sortBy')} aria-label={t('folderView.sortBy')}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="4" y1="6" x2="20" y2="6" /><line x1="6" y1="12" x2="18" y2="12" /><line x1="9" y1="18" x2="15" y2="18" />
      </svg>
    </button>
```

- [ ] **Step 3: 渲染排序菜单**（放在 `node-ctx-menu` 那段 `{#if ctx.open}` 附近，文件末尾模板处）

```svelte
{#if sortMenu.open}
  <div class="sort-menu menu-panel" role="menu" style="left: {sortMenu.x}px; top: {sortMenu.y}px">
    {#each SORT_OPTS as opt (opt.key)}
      <button type="button" role="menuitemradio" aria-checked={folderView.sort === opt.key}
        class="node-ctx-item menu-row" onclick={() => void pickSort(opt.key)}>
        <span class="check">{folderView.sort === opt.key ? '✓' : ''}</span>{t(opt.label)}
      </button>
    {/each}
    <div class="sort-sep"></div>
    <button type="button" role="menuitemcheckbox" aria-checked={folderView.notesOnly}
      class="node-ctx-item menu-row" onclick={() => void toggleNotesOnly()}>
      <span class="check">{folderView.notesOnly ? '✓' : ''}</span>{t('folderView.notesOnly')}
    </button>
  </div>
{/if}
```

- [ ] **Step 4: 右键菜单加置顶项**（reveal 按钮之后，`FolderView.svelte:199-201` 附近）

```svelte
    <button type="button" role="menuitem" class="node-ctx-item menu-row" onclick={pinCtx}>
      {ctx.entry?.pinned ? t('folderView.unpin') : t('folderView.pin')}
    </button>
```

- [ ] **Step 5: 样式**（`<style>` 里 `.node-ctx-menu` 附近）

```css
  .sort-menu { position: fixed; z-index: 9998; min-width: 180px; }
  .sort-menu .check { display: inline-block; width: 14px; }
  .sort-sep { height: 1px; margin: 4px 0; background: var(--border-color, #3333); }
```

- [ ] **Step 6: check 通过**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -E "FolderView" | grep -i error || echo clean`
Expected: `clean`

- [ ] **Step 7: 提交**

```bash
git add src/components/FolderView.svelte
git commit -m "feat(folder-view): sort menu, notes-only checkbox, pin context action"
```

---

## Task 7: FolderTreeNode —— 图钉角标 + children notesOnly

**Files:**
- Modify: `src/components/FolderTreeNode.svelte`

- [ ] **Step 1: import applyNotesOnly**

```ts
  import { folderView, toggleExpanded, applyNotesOnly, type FolderEntry } from '../lib/folder-view.svelte'
```

- [ ] **Step 2: children derived 套 notesOnly**（line 49-52 替换）

```ts
  let children = $derived.by<FolderEntry[]>(() => {
    const all = folderView.entriesCache.get(entry.path) ?? []
    const filtered = filtering ? all.filter((c) => folderView.filterVisible.has(c.path)) : all
    return applyNotesOnly(filtered, folderView.notesOnly)
  })
```

- [ ] **Step 3: 行内加图钉角标**（`{#if entry.hasNote && entry.notePath}` 那段之前插入）

```svelte
  {#if entry.pinned}
    <span class="pin-badge" title="pinned" aria-hidden="true">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M14 4v5l3 3v2h-5v5l-1 1-1-1v-5H5v-2l3-3V4h-1V2h8v2z" />
      </svg>
    </span>
  {/if}
```

- [ ] **Step 4: 样式**（`<style>` 里 `.note-badge` 附近）

```css
  .pin-badge { flex: 0 0 auto; display: inline-flex; opacity: 0.55; }
```

- [ ] **Step 5: check 通过**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -E "FolderTreeNode" | grep -i error || echo clean`
Expected: `clean`

- [ ] **Step 6: 提交**

```bash
git add src/components/FolderTreeNode.svelte
git commit -m "feat(folder-view): pin badge + notes-only on child rows"
```

---

## Task 8: 全量 check + test

- [ ] **Step 1: 单元测试**

Run: `pnpm test`
Expected: 全绿（含新增 folder-view 用例）。

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 0 error。

- [ ] **Step 3: 失败则按 systematic-debugging 修复后重跑**

---

## Task 9: dev GUI 实机验证（人工）

遵循 [[feedback_no_ui_automation_user_tests]]：起 dev + 手动步骤，不做桌面自动化。

- [ ] **Step 1: 起 dev**

Run: `pnpm tauri dev`

- [ ] **Step 2: 验收**

1. 文件夹视图默认按最后编辑时间（新→旧）；工具栏排序菜单切"名称""创建时间（最新）"即时生效，全树一致，重启后保留。
2. 右键某文件/文件夹→置顶：浮到该目录顶部并显示图钉；该目录出现 `.notemd.json`（仅此时）。
3. 取消该目录最后一个置顶 → `.notemd.json` 消失。
4. 置顶多项：顺序=置顶先后。
5. 排序菜单勾选"只显示有笔记的文件"：仅剩有配对 `.note.md` 的主文档（+文件夹），取消勾选恢复；与名称搜索可叠加。

---

## Self-Review 记录

- **Spec 覆盖**：三种排序→Task 1+Task 4(setSort/load)+Task 6(菜单)；置顶+`.notemd.json` 空则删→Task 2(parse)+Task 4(readPinned/togglePin)+Task 6(右键)+Task 7(角标)；全局排序存 settings.json→Task 4；只显示有笔记→Task 3+Task 6+Task 7；i18n→Task 5。全覆盖。
- **占位符**：无 TBD/TODO；每步给了完整代码。
- **类型一致**：`FolderSortKey`('edited'|'name'|'created')、`sortEntries(entries,sort,pinned)`、`parsePinned`、`applyNotesOnly`、`readPinned`/`togglePin`/`setSort`/`setNotesOnly`、`PINNED_FILE`、`FolderEntry.{mtime,birthtime,pinned}` 定义与调用一致。
- **风险**：readFolder 每次多 N 次 stat（并行，可接受）；`.notemd.json` 写触发 watcher→refreshAll 重读(无写→无循环)；`stat` 返回 mtime/birthtime 为 Date，`new Date(x).getTime()` 兼容；test 需把 plugin-fs mock 从只 readDir 扩为含 stat/exists/readTextFile 等（Task 4 Step 1）。
