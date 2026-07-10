# `.note.md` 基础功能升级 — 补章:重命名与改名联动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FolderView 右键"重命名"(行内编辑),`renamePair` 保证 `xxx.md` 改名时其伴生 `xxx.note.md`/`xxx.notes.md` 同步改名(失败回滚),已打开 tab 路径联动。

**Architecture:** 纯决策层(`rename-pair.ts`:目标路径推导、伴生配对、冲突判定)单测;IO 层(依次 rename、失败回滚)薄;tabs 路径联动复用 `rebindTabPath`。UI 为 FolderTreeNode 行内 input(与 FolderView 右键菜单一项联动)。

**Tech Stack:** Svelte 5、TypeScript、vitest、@tauri-apps/plugin-fs(rename/exists)

**Spec:** `docs/superpowers/specs/2026-07-10-outline-note-base-design.md` §7(2026-07-10 补做版)

---

### Task 1: rename-pair.ts — 计划推导(纯)+ 执行(IO,回滚)

**Files:**
- Create: `src/lib/outline/rename-pair.ts`
- Test: `src/lib/outline/rename-pair.test.ts`

- [ ] **Step 1: 写失败测试** — 新建 `rename-pair.test.ts`:

```ts
// src/lib/outline/rename-pair.test.ts
import { describe, it, expect } from 'vitest'
import { planRename } from './rename-pair'

describe('planRename', () => {
  it('renaming xxx.md pairs its companion (new suffix)', () => {
    const plan = planRename('/d/a.md', 'b.md', ['a.md', 'a.note.md', 'z.md'])
    expect(plan).toEqual({
      ops: [
        { from: '/d/a.md', to: '/d/b.md' },
        { from: '/d/a.note.md', to: '/d/b.note.md' },
      ],
    })
  })
  it('legacy .notes.md companion pairs too, keeps legacy suffix', () => {
    const plan = planRename('/d/a.md', 'b.md', ['a.md', 'a.notes.md'])
    expect(plan).toEqual({
      ops: [
        { from: '/d/a.md', to: '/d/b.md' },
        { from: '/d/a.notes.md', to: '/d/b.notes.md' },
      ],
    })
  })
  it('no companion → single op', () => {
    expect(planRename('/d/a.md', 'b.md', ['a.md'])).toEqual({
      ops: [{ from: '/d/a.md', to: '/d/b.md' }],
    })
  })
  it('renaming a .note.md renames only itself (no reverse pairing)', () => {
    expect(planRename('/d/a.note.md', 'c.note.md', ['a.md', 'a.note.md'])).toEqual({
      ops: [{ from: '/d/a.note.md', to: '/d/c.note.md' }],
    })
  })
  it('sanitizes the new name (illegal chars → -)', () => {
    const plan = planRename('/d/a.md', 'x/y.md', ['a.md'])
    expect(plan!.ops[0].to).toBe('/d/x-y.md')
  })
  it('conflict: target name already exists in dir → null', () => {
    expect(planRename('/d/a.md', 'z.md', ['a.md', 'z.md'])).toBeNull()
    // 伴生目标冲突同样中止
    expect(planRename('/d/a.md', 'w.md', ['a.md', 'a.note.md', 'w.note.md'])).toBeNull()
  })
  it('no-op: same name → null', () => {
    expect(planRename('/d/a.md', 'a.md', ['a.md'])).toBeNull()
  })
  it('case-insensitive conflict detection, but case-only rename of itself allowed', () => {
    expect(planRename('/d/a.md', 'Z.md', ['a.md', 'z.md'])).toBeNull()
    const plan = planRename('/d/a.md', 'A.md', ['a.md'])
    expect(plan).toEqual({ ops: [{ from: '/d/a.md', to: '/d/A.md' }] })
  })
})
```

- [ ] **Step 2:** `pnpm vitest run src/lib/outline/rename-pair.test.ts` → FAIL(模块不存在)

- [ ] **Step 3: 实现**

```ts
// src/lib/outline/rename-pair.ts
import { sanitizeFileName } from './slug'
import { parentDir } from '../folder-view.svelte'
import { joinPath } from '../fs'

export interface RenameOp { from: string; to: string }
export interface RenamePlan { ops: RenameOp[] }

const NOTE_SUFFIX_RE = /\.notes?\.md$/i

/**
 * 重命名计划(纯,spec §7):
 * - 主文档 xxx.md 改名 → 同目录配对伴生(.note.md/.notes.md,保留各自后缀)联动;
 * - .note.md 自身改名只改自身;
 * - newName 经 sanitizeFileName;同名 no-op、目标冲突(大小写不敏感,排除自身)→ null。
 * siblings 为该目录现有文件名列表(含被改文件)。
 */
export function planRename(oldPath: string, newNameRaw: string, siblings: string[]): RenamePlan | null {
  const dir = parentDir(oldPath)
  const oldName = oldPath.slice(dir.length + (dir === '/' ? 0 : 1))
  const newName = sanitizeFileName(newNameRaw)
  if (newName === oldName) return null

  const lowerSiblings = new Set(siblings.map(s => s.toLowerCase()))
  const conflicts = (name: string, self: string) =>
    name.toLowerCase() !== self.toLowerCase() && lowerSiblings.has(name.toLowerCase())
  if (conflicts(newName, oldName)) return null

  const ops: RenameOp[] = [{ from: oldPath, to: joinPath(dir, newName) }]

  // 主文档改名 → 伴生联动(仅 .md → .md 的改名;伴生自身改名不反向联动)
  const isMain = /\.md$/i.test(oldName) && !NOTE_SUFFIX_RE.test(oldName)
  const newIsMd = /\.md$/i.test(newName) && !NOTE_SUFFIX_RE.test(newName)
  if (isMain && newIsMd) {
    const base = oldName.replace(/\.md$/i, '')
    const newBase = newName.replace(/\.md$/i, '')
    for (const suffix of ['.note.md', '.notes.md']) {
      const compName = siblings.find(s => s.toLowerCase() === (base + suffix).toLowerCase())
      if (compName) {
        const compNew = newBase + suffix
        if (conflicts(compNew, compName)) return null   // 伴生目标冲突 → 整体中止
        ops.push({ from: joinPath(dir, compName), to: joinPath(dir, compNew) })
      }
    }
  }
  return { ops }
}

/**
 * 执行计划:依次 rename;任何一步失败则把已完成的 op 逆序回滚(尽力而为的
 * 原子性,spec §7)。成功返回 null,失败返回错误信息。IO 薄层,手动验证。
 */
export async function executeRename(plan: RenamePlan): Promise<string | null> {
  const { rename } = await import('@tauri-apps/plugin-fs')
  const done: RenameOp[] = []
  for (const op of plan.ops) {
    try {
      await rename(op.from, op.to)
      done.push(op)
    } catch (e) {
      for (const u of done.reverse()) {
        await rename(u.to, u.from).catch(() => {})   // 回滚失败只能尽力
      }
      return String(e)
    }
  }
  return null
}
```

- [ ] **Step 4:** `pnpm vitest run src/lib/outline/rename-pair.test.ts` → PASS;`pnpm check` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/rename-pair.ts src/lib/outline/rename-pair.test.ts
git commit -m "feat(outline): renamePair plan/execute — companion co-rename with rollback"
```

---

### Task 2: tabs 路径联动 updateTabPath

**Files:**
- Modify: `src/lib/tabs.svelte.ts`
- Test: `src/lib/tabs.test.ts`

- [ ] **Step 1: 写失败测试** — `tabs.test.ts` 追加(参考该文件现有 mock 风格,顶部 mock 已就绪则直接用):

```ts
  it('updateTabPath rebinds filePath and title without touching content', async () => {
    await m.openFile('/tmp/old.md')
    const tab = m.tabs.find((t: { filePath: string }) => t.filePath === '/tmp/old.md')!
    m.setContent(tab.id, 'edited')
    await m.updateTabPath('/tmp/old.md', '/tmp/new.md')
    expect(tab.filePath).toBe('/tmp/new.md')
    expect(tab.title).toBe('new.md')
    expect(tab.currentContent).toBe('edited')
  })
  it('updateTabPath is a no-op when no tab has the path', async () => {
    await expect(m.updateTabPath('/tmp/nope.md', '/tmp/x.md')).resolves.toBeUndefined()
  })
```

(先读 `tabs.test.ts` 的既有 setup/mocks——`openFile` 已被测,沿用同一套 vi.mock;若 `rebindTabPath` 的 mock 缺失按现有 file-watcher mock 方式补。)

- [ ] **Step 2:** 跑测试确认 FAIL

- [ ] **Step 3: 实现** — `tabs.svelte.ts` 追加(放 `saveAs` 附近):

```ts
/** 文件被应用内重命名后:更新受影响 tab 的路径/标题并重绑 watcher(spec §7)。
 *  不改内容与脏态;调用方负责磁盘上的实际 rename。 */
export async function updateTabPath(oldPath: string, newPath: string): Promise<void> {
  const t = tabs.find((x) => x.filePath === oldPath)
  if (!t) return
  t.filePath = newPath
  t.title = basename(newPath)
  const cls = classifyPath(newPath)
  if (cls) { t.kind = cls.kind; t.language = cls.language }
  await rebindTabPath(t.id)
  await pushRecentFile(newPath)
}
```

- [ ] **Step 4:** `pnpm vitest run src/lib/tabs.test.ts` → PASS;`pnpm check` → 0

- [ ] **Step 5: Commit**

```bash
git add src/lib/tabs.svelte.ts src/lib/tabs.test.ts
git commit -m "feat(tabs): updateTabPath — rebind open tab after in-app rename"
```

---

### Task 3: FolderView 行内重命名 UI

**Files:**
- Modify: `src/components/FolderView.svelte`(右键菜单加"重命名"项 + renaming 状态下发)
- Modify: `src/components/FolderTreeNode.svelte`(行内 input)
- Modify: `src/lib/i18n/en.ts`、`zh.ts`、`ja.ts`

- [ ] **Step 1: FolderView** — ctx 菜单(`node-ctx-menu`,~line 174)在 reveal 项后加:

```svelte
    {#if ctx.entry && !ctx.entry.isDir}
      <button type="button" role="menuitem" class="node-ctx-item menu-row" onclick={renameCtx}>
        {t('folderView.rename')}
      </button>
    {/if}
```

脚本区新增状态与提交逻辑:

```ts
  import { planRename, executeRename } from '../lib/outline/rename-pair'
  import { updateTabPath } from '../lib/tabs.svelte'
  import { pushToast } from '../lib/toast.svelte'

  let renamingPath = $state<string | null>(null)

  function renameCtx() {
    const p = ctx.entry?.path
    closeCtxMenu()
    if (p) renamingPath = p
  }

  async function commitRename(entry: FolderEntry, newName: string) {
    renamingPath = null
    const dir = parentDir(entry.path)
    const siblings = (folderView.entriesCache.get(dir) ?? [])
      .filter(e => !e.isDir).map(e => e.name)
    // 配对隐藏的伴生行不在 entriesCache 里 → 把 notePath 的文件名补进 siblings
    for (const e of folderView.entriesCache.get(dir) ?? []) {
      if (e.notePath) siblings.push(e.notePath.slice(e.notePath.lastIndexOf('/') + 1))
    }
    const plan = planRename(entry.path, newName, siblings)
    if (!plan) {
      if (newName !== entry.name) pushToast({ level: 'warn', message: t('folderView.renameConflict') })
      return
    }
    const err = await executeRename(plan)
    if (err) { pushToast({ level: 'error', message: err }); return }
    for (const op of plan.ops) await updateTabPath(op.from, op.to)
    await refreshAll()
  }
```

(`parentDir`、`refreshAll`、`folderView` 已在该文件使用——按现有 import 补齐;`FolderEntry` type import 已存在。)
`FolderTreeNode` 调用处传 prop:`renaming={entry.path === renamingPath}` 与 `onRenameCommit={(name) => commitRename(entry, name)}`、`onRenameCancel={() => (renamingPath = null)}`——注意 FolderTreeNode 递归渲染子节点时也要透传 `renamingPath`/`commitRename`(prop 下发按现有 `onOpen`/`onContextMenu` 的透传方式,传 `renamingPath` 字符串与两个回调,子节点自行比较 path)。

- [ ] **Step 2: FolderTreeNode** — props 增加:

```ts
    renamingPath?: string | null
    onRenameCommit?: (entry: FolderEntry, name: string) => void
    onRenameCancel?: () => void
```

label 渲染分支(替换 `<span class="label">{entry.name}</span>`):

```svelte
  {#if renamingPath === entry.path}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="rename-input"
      type="text"
      value={entry.name}
      autofocus
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); onRenameCommit?.(entry, (e.currentTarget as HTMLInputElement).value) }
        else if (e.key === 'Escape') { e.preventDefault(); onRenameCancel?.() }
      }}
      onblur={(e) => onRenameCommit?.(entry, (e.currentTarget as HTMLInputElement).value)}
    />
  {:else}
    <span class="label">{entry.name}</span>
  {/if}
```

递归子节点透传三个新 prop。style 增加:

```css
  .rename-input {
    flex: 1; min-width: 0; font: inherit; font-size: 13px;
    padding: 0 2px; border: 1px solid var(--accent-color, #4a80d4);
    border-radius: 3px; background: Canvas; color: CanvasText; outline: none;
  }
```

注意宿主是 `<button class="node">`——input 在 button 内,click/keydown 需 stopPropagation(如上);若 svelte-check 对 button 内 input 报 ERROR(非 warning),把该行的宿主从 `<button>` 换 `<div role="button" tabindex="0">` 仅在 renaming 时——先试最小改动,报告实际处理。

- [ ] **Step 3: i18n** — en:`'folderView.rename': 'Rename'`、`'folderView.renameConflict': 'A file with that name already exists'`;zh:`'重命名'`、`'同名文件已存在'`;ja:`'名前を変更'`、`'同名のファイルが既に存在します'`。

- [ ] **Step 4:** `pnpm check && pnpm test` → 全绿

- [ ] **Step 5: Commit**

```bash
git add src/components/FolderView.svelte src/components/FolderTreeNode.svelte src/lib/i18n
git commit -m "feat(folder-view): inline rename with companion co-rename (spec §7)"
```

---

### Task 4: 回归 + dev 实机验证

- [ ] `pnpm check && pnpm test` 全绿
- [ ] dev 实机(fixtures /tmp/nvrn:`a.md`+`a.note.md`+`z.md`):
  1. 右键 `a.md` → 重命名 → 输入 `b.md` 回车 → 磁盘上 `a.md`/`a.note.md` 同步变 `b.md`/`b.note.md`,树行与角标随之更新
  2. 重命名为已存在的 `z.md` → 冲突 toast,文件不动
  3. `a.md` 开着 tab 时重命名 → tab 标题变 `b.md`,继续编辑保存写入新路径
  4. Esc 取消不改名
  5. 右键目录无"重命名"项
- [ ] 提交验证记录;合并 main;发布 v4.7.0

---

## Self-Review 结果

- **Spec 覆盖:** §7 重命名入口(Task 3)、sanitize 约束与不覆盖(Task 1 planRename)、伴生联动含旧后缀+回滚(Task 1)、.note.md 自身改名不反向联动(Task 1 测试)、tab 路径联动(Task 2 + Task 3 commitRename)、目录不支持(Task 3 ctx gate)、不改写入链(无代码,spec 已注明)。
- **占位符:** 无。
- **类型一致性:** `planRename(oldPath,newNameRaw,siblings) → RenamePlan|null`、`executeRename(plan) → string|null`、`updateTabPath(old,new)` 贯穿 Task 1/2/3。
