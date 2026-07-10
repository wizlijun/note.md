# Wikilink Page Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `[[X]]` 的可解析目标从「全 vault 每个 `.md`」收窄到「`wikipage/`、`dailynote/` 约定目录下（递归）的文件」，消除散落文档带来的命名冲突；反链来源仍扫全 vault。

**Architecture:** 给 `BacklinkIndex` 附带一个 `PageScope { root, dirs }`。`byTarget`（反链来源）照旧记录所有 `.md` 的出链；`filePages`（解析目标 + 补全候选）只在文件通过 `isWikiPagePath` 判定时才写入。`resolveTarget`/`detectNameCollisions`/`pageCandidates` 读 `filePages`，自动收窄。scope 为空则退回旧行为（所有 `.md` 都是页面），保证向后兼容与纯逻辑测试。

**Tech Stack:** TypeScript、Svelte 5 runes、Tauri plugin-fs、Vitest、svelte-check。

**Spec:** `docs/superpowers/specs/2026-07-11-wikilink-page-scope-design.md`

---

## File Structure

- `src/lib/outline/backlinks.ts`（改）— 新增 `PageScope` 类型、`isWikiPagePath` 纯函数、`BacklinkIndex.scope` 字段；`createIndex`/`indexFileContent`/`buildFolderIndex` 按 scope 分流。
- `src/lib/outline/backlinks.test.ts`（改）— 新增 scoped 判定与解析/冲突用例；保留旧无 scope 用例作为向后兼容验证。
- `src/lib/outline/backlinks-io.svelte.ts`（改）— `ensureIndex` 调 `buildFolderIndex` 时传入 `[outlineDirs.wikipage, outlineDirs.dailynote]`。

IO 薄层（`backlinks-io.svelte.ts` / `buildFolderIndex`）沿仓库惯例不写 vitest，靠 `svelte-check` + 手动验证。

---

## Task 1: PageScope 类型 + isWikiPagePath 纯函数 + scope 字段

**Files:**
- Modify: `src/lib/outline/backlinks.ts:7-18`（`BacklinkIndex` 接口与 `createIndex`）
- Test: `src/lib/outline/backlinks.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/outline/backlinks.test.ts` 顶部 import 追加 `isWikiPagePath`：

```ts
import { createIndex, indexFileContent, removeFileFromIndex, backlinksFor, pageNameOf, pageCandidates, resolveTarget, detectNameCollisions, isWikiPagePath } from './backlinks'
```

在文件末尾追加：

```ts
describe('isWikiPagePath', () => {
  const scope = { root: '/v', dirs: ['wikipage', 'dailynote'] }
  it('true for .md directly under a scope dir', () => {
    expect(isWikiPagePath(scope, '/v/wikipage/x.note.md')).toBe(true)
  })
  it('true for .md nested deeper under a scope dir (recursive)', () => {
    expect(isWikiPagePath(scope, '/v/dailynote/2026/2026-07-11.note.md')).toBe(true)
  })
  it('false for .md outside scope dirs', () => {
    expect(isWikiPagePath(scope, '/v/sub/x.md')).toBe(false)
  })
  it('false for a file sitting at root without a scope dir', () => {
    expect(isWikiPagePath(scope, '/v/x.md')).toBe(false)
  })
  it('false for non-.md even under a scope dir', () => {
    expect(isWikiPagePath(scope, '/v/wikipage/x.txt')).toBe(false)
  })
  it('false when path is outside root', () => {
    expect(isWikiPagePath(scope, '/other/wikipage/x.md')).toBe(false)
  })
  it('null scope → every .md is a page (backward compat)', () => {
    expect(isWikiPagePath(null, '/anywhere/x.md')).toBe(true)
    expect(isWikiPagePath(null, '/anywhere/x.txt')).toBe(false)
  })
  it('tolerates trailing slash on root', () => {
    expect(isWikiPagePath({ root: '/v/', dirs: ['wikipage'] }, '/v/wikipage/x.md')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/outline/backlinks.test.ts`
Expected: FAIL —— `isWikiPagePath` 未导出（`isWikiPagePath is not a function` / TS 报错）。

- [ ] **Step 3: 实现类型、字段与纯函数**

在 `src/lib/outline/backlinks.ts` 把 `BacklinkIndex` 接口与 `createIndex` 改为：

```ts
/** 页面命名空间：root 下第一段目录 ∈ dirs 的 .md 才算 wiki 页（递归）。 */
export interface PageScope { root: string; dirs: string[] }

export interface BacklinkIndex {
  /** lowercased target → hits */
  byTarget: Map<string, BacklinkHit[]>
  /** file → its targets（增量更新用） */
  fileTargets: Map<string, Set<string>>
  /** 已索引「wiki 页」的页面名（[[ 补全候选 / 解析目标） */
  filePages: Map<string, string>
  /** 页面命名空间；null = 所有 .md 都是页面（向后兼容） */
  scope: PageScope | null
}

export function createIndex(scope: PageScope | null = null): BacklinkIndex {
  return { byTarget: new Map(), fileTargets: new Map(), filePages: new Map(), scope }
}

/**
 * path 是否为「wiki 页」：相对 scope.root 的第一段 ∈ scope.dirs 且以 .md 结尾（递归子目录都算）。
 * scope 为 null → 所有 .md 都是页面（纯逻辑调用 / 向后兼容）。
 */
export function isWikiPagePath(scope: PageScope | null, path: string): boolean {
  if (!/\.md$/i.test(path)) return false
  if (!scope) return true
  const root = scope.root.endsWith('/') ? scope.root.slice(0, -1) : scope.root
  if (!path.startsWith(root + '/')) return false
  const segs = path.slice(root.length + 1).split('/')
  return segs.length >= 2 && scope.dirs.includes(segs[0])
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/outline/backlinks.test.ts`
Expected: PASS（`isWikiPagePath` 全绿；旧用例仍绿，因 `createIndex()` 默认 scope=null）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/outline/backlinks.ts src/lib/outline/backlinks.test.ts
git commit -m "feat(outline): add PageScope + isWikiPagePath to backlink index"
```

---

## Task 2: indexFileContent 按 scope 分流 filePages

**Files:**
- Modify: `src/lib/outline/backlinks.ts:38-58`（`indexFileContent`）
- Test: `src/lib/outline/backlinks.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/outline/backlinks.test.ts` 末尾追加一个 scoped describe（用带 scope 的索引 helper）：

```ts
describe('scoped index (wikipage/dailynote only)', () => {
  const SCOPE = { root: '/v', dirs: ['wikipage', 'dailynote'] }
  function scopedIdx(files: Record<string, string>) {
    const idx = createIndex(SCOPE)
    for (const [p, c] of Object.entries(files)) indexFileContent(idx, p, c)
    return idx
  }

  it('wiki page beats a同名 stray .md; stray is unresolvable', () => {
    const idx = scopedIdx({ '/v/sub/x.md': 'x', '/v/wikipage/x.note.md': '- x' })
    expect(resolveTarget(idx, 'x')).toBe('/v/wikipage/x.note.md')
  })
  it('two stray .md with same name are NOT a collision', () => {
    const idx = scopedIdx({ '/v/a/foo.md': '1', '/v/b/foo.md': '2' })
    expect(detectNameCollisions(idx).size).toBe(0)
  })
  it('two wiki pages with same name ARE a collision', () => {
    const idx = scopedIdx({
      '/v/wikipage/foo.note.md': '- 1',
      '/v/wikipage/sub/foo.note.md': '- 2',
    })
    expect(detectNameCollisions(idx).get('foo')).toHaveLength(2)
  })
  it('nested dailynote page is resolvable (recursive)', () => {
    const idx = scopedIdx({ '/v/dailynote/2026/2026-07-11.note.md': '- d' })
    expect(resolveTarget(idx, '2026-07-11')).toBe('/v/dailynote/2026/2026-07-11.note.md')
  })
  it('stray doc linking a wiki page is still a backlink source', () => {
    const idx = scopedIdx({
      '/v/sub/note.md': '- see [[Wiki]] here\n',
      '/v/wikipage/wiki.note.md': '- x',
    })
    expect(resolveTarget(idx, 'stray-none')).toBeNull()
    expect(backlinksFor(idx, 'wiki')).toEqual([
      { file: '/v/sub/note.md', text: 'see [[Wiki]] here', line: 1 },
    ])
    expect(pageCandidates(idx)).toEqual(['wiki'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/lib/outline/backlinks.test.ts`
Expected: FAIL —— 目前 `indexFileContent` 无条件写 `filePages`，故 `/v/sub/x.md` 仍被当页面：`two stray .md ... NOT a collision` 会得到冲突、`pageCandidates` 会多出条目、`resolveTarget('x')` 会因 `.md` 优先返回 `/v/sub/x.md`。

- [ ] **Step 3: 按 scope 分流实现**

在 `src/lib/outline/backlinks.ts` 的 `indexFileContent`，把这一行：

```ts
  idx.filePages.set(file, pageNameOf(file))
```

改为：

```ts
  if (isWikiPagePath(idx.scope, file)) idx.filePages.set(file, pageNameOf(file))
```

（`byTarget`/`fileTargets` 的记录逻辑保持不变——反链来源仍收全部文件。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/lib/outline/backlinks.test.ts`
Expected: PASS —— scoped 用例全绿；旧无 scope 用例仍绿（默认 scope=null → 所有 `.md` 都是页面）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/outline/backlinks.ts src/lib/outline/backlinks.test.ts
git commit -m "feat(outline): gate filePages by PageScope in indexFileContent"
```

---

## Task 3: buildFolderIndex 接受 dirs 参数并接线 IO 层

**Files:**
- Modify: `src/lib/outline/backlinks.ts:108-138`（`buildFolderIndex`）
- Modify: `src/lib/outline/backlinks-io.svelte.ts:6`（import）、`:35`（调用）

- [ ] **Step 1: 给 buildFolderIndex 加 dirs 参数并建带 scope 的索引**

把 `src/lib/outline/backlinks.ts` 的 `buildFolderIndex` 签名与首行改为：

```ts
export async function buildFolderIndex(
  rootDir: string,
  dirs: string[],
  onMigrateConflict?: (legacyPath: string) => void,
): Promise<BacklinkIndex> {
  const { readDir, readTextFile, stat } = await import('@tauri-apps/plugin-fs')
  const idx = createIndex({ root: rootDir, dirs })
```

（函数体其余不变：仍递归 `walk`、迁移旧后缀、`indexFileContent` 逐文件；页面判定已在 `indexFileContent` 内按 `idx.scope` 完成。）

- [ ] **Step 2: 接线 backlinks-io 传入约定目录**

`src/lib/outline/backlinks-io.svelte.ts` 顶部已 `import { outlineDirs } from './dirs.svelte'`（无需新增）。把 `ensureIndex` 里的这段：

```ts
  const idx = await buildFolderIndex(root, (legacyPath) => {
    pushToast({ level: 'warn', message: t('outline.migrate.conflict', { path: legacyPath }) })
  })
```

改为：

```ts
  const idx = await buildFolderIndex(root, [outlineDirs.wikipage, outlineDirs.dailynote], (legacyPath) => {
    pushToast({ level: 'warn', message: t('outline.migrate.conflict', { path: legacyPath }) })
  })
```

- [ ] **Step 3: 类型检查**

Run: `pnpm check`
Expected: PASS —— 无类型错误（`buildFolderIndex` 的所有调用点均已传 `dirs`；确认无其他调用点：`grep -rn "buildFolderIndex(" src` 只应出现定义处与此调用处）。

- [ ] **Step 4: 全量单测**

Run: `pnpm test`
Expected: PASS —— 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/lib/outline/backlinks.ts src/lib/outline/backlinks-io.svelte.ts
git commit -m "feat(outline): pass wikipage/dailynote dirs into buildFolderIndex"
```

---

## Task 4: 收尾校验

**Files:** 无（仅校验）

- [ ] **Step 1: 确认无遗漏调用点**

Run: `grep -rn "buildFolderIndex(" src`
Expected: 仅两处——`backlinks.ts` 定义、`backlinks-io.svelte.ts` 调用（已带 dirs）。

- [ ] **Step 2: 全量 check + test**

Run: `pnpm check && pnpm test`
Expected: 两者均 PASS。

- [ ] **Step 3: 手动验证提示（IO 薄层无自动化覆盖）**

在真实 vault（含 `wikipage/`、`dailynote/2026/…` 及散落 `commoncog-…` 文档）里打开大纲面板，确认：
- 不再弹出「95 组链接名冲突」toast（散落同名文档不再计冲突）。
- `[[` 补全候选只列 wikipage/dailynote 下的页面。
- 散落文档里的 `[[某wiki页]]` 仍出现在该页 backlinks。

此步为人工确认，非阻塞自动化；结果记录到会话即可。

---

## Self-Review

- **Spec 覆盖**：决策 1（来源全量）→ Task 2 保留 `byTarget` 全量 + 测试「stray doc 仍是反链来源」；决策 2（含 dailynote）→ Task 3 传 `[wikipage, dailynote]` + Task 2 dailynote 用例；决策 3（非 vault 同规则）→ `isWikiPagePath` 以 root 相对判定，非 vault 根无 wikipage 目录即无页面，Task 1 覆盖；决策 4（递归）→ Task 1「nested」+ Task 2「dailynote/2026」用例；决策 5（普通 `.md` 也算）→ `isWikiPagePath` 只校验 `.md` 后缀，未强制 `.note.md`，Task 2「stray? 不」与「wiki page x.note.md」共存说明后缀不敏感。全部有任务承接。
- **占位符**：无 TBD/TODO；每个代码步均给出完整代码。
- **类型一致**：`PageScope`、`isWikiPagePath(scope, path)`、`createIndex(scope?)`、`buildFolderIndex(rootDir, dirs, onMigrate?)`、`BacklinkIndex.scope` 在各任务间命名一致。
