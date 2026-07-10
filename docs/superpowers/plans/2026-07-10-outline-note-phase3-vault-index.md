# `.note.md` 基础功能升级 — 第三期:vault 级链接命名空间 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `[[title]]` 索引升级为 vault 全局命名空间(按文件名解析,Obsidian 兼容),独立 `.note.md` 可作为链接目标,文件名碰撞 toast 上报,未解析链接在 `vault/{wikipage}/` 建大纲页;wikipage/dailynote 目录名全局可配置。

**Architecture:** 索引机制不变(`buildFolderIndex` + watch),仅升级**根目录选择**(文件在 vault 内 → `sotvaultStore.vaultRoot`,否则维持现状)与**解析规则**(新纯函数 `resolveTarget`:主文档优先、独立笔记可为目标、伴生笔记永不为目标)。目录名配置走 `gate.svelte.ts` 同款 Store 持久化模式,UI 进现有 outline-notes 设置页。

**Tech Stack:** Svelte 5 runes、TypeScript、vitest、@tauri-apps/plugin-fs、@tauri-apps/plugin-store

**Spec:** `docs/superpowers/specs/2026-07-10-outline-note-base-design.md` §5(含 2026-07-10 file-over-app 修订)、§6 首条(目录名配置)

---

### Task 1: 目录名配置(wikipageDir / dailynoteDir)+ 设置 UI

**Files:**
- Create: `src/lib/outline/dirs.svelte.ts`
- Test: `src/lib/outline/dirs.test.ts`
- Modify: `src/App.svelte:180 附近`(`loadOutlineGate()` 旁加载)
- Modify: `src/components/SettingsDialog.svelte`(outline-notes 设置页,line ~664 区域)
- Modify: `src/lib/i18n/en.ts`、`zh.ts`、`ja.ts`

- [ ] **Step 1: 写失败测试** — 新建 `dirs.test.ts`:

```ts
// src/lib/outline/dirs.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeDirName, DEFAULT_DIRS } from './dirs.svelte'

describe('normalizeDirName', () => {
  it('keeps legal names, sanitizes illegal chars', () => {
    expect(normalizeDirName('wikipage', 'wikipage')).toBe('wikipage')
    expect(normalizeDirName('我的wiki', 'wikipage')).toBe('我的wiki')
    expect(normalizeDirName('a/b', 'wikipage')).toBe('a-b')
  })
  it('empty/blank falls back to provided default', () => {
    expect(normalizeDirName('', 'wikipage')).toBe('wikipage')
    expect(normalizeDirName('   ', 'dailynote')).toBe('dailynote')
  })
})

describe('DEFAULT_DIRS', () => {
  it('matches spec defaults', () => {
    expect(DEFAULT_DIRS).toEqual({ wikipage: 'wikipage', dailynote: 'dailynote' })
  })
})
```

- [ ] **Step 2:** `pnpm vitest run src/lib/outline/dirs.test.ts` → FAIL(模块不存在)

- [ ] **Step 3: 实现** — `dirs.svelte.ts`(模式对照 `gate.svelte.ts`):

```ts
// src/lib/outline/dirs.svelte.ts
import { Store } from '@tauri-apps/plugin-store'
import { sanitizeFileName } from './slug'

export const DEFAULT_DIRS = { wikipage: 'wikipage', dailynote: 'dailynote' } as const

/** vault 内约定目录名(spec §一/§6:全局可配置,默认 wikipage/dailynote) */
export const outlineDirs = $state<{ wikipage: string; dailynote: string }>({ ...DEFAULT_DIRS })

/** 目录名约束:单段合法文件名;空白回退默认值 */
export function normalizeDirName(raw: string, fallback: string): string {
  const s = sanitizeFileName(raw)
  return s === 'untitled' && raw.trim() === '' ? fallback : (s || fallback)
}

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

/** 与 loadOutlineGate 同时机调用(settings 水合后) */
export async function loadOutlineDirs(): Promise<void> {
  const s = await getStore()
  outlineDirs.wikipage = (await s.get<string>('outline.wikipageDir')) ?? DEFAULT_DIRS.wikipage
  outlineDirs.dailynote = (await s.get<string>('outline.dailynoteDir')) ?? DEFAULT_DIRS.dailynote
}

export async function setOutlineDir(kind: 'wikipage' | 'dailynote', raw: string): Promise<void> {
  const v = normalizeDirName(raw, DEFAULT_DIRS[kind])
  outlineDirs[kind] = v
  const s = await getStore()
  await s.set(kind === 'wikipage' ? 'outline.wikipageDir' : 'outline.dailynoteDir', v)
  await s.save()
}
```

注意 `normalizeDirName('', ...)`:`sanitizeFileName('')` 返回 `'untitled'`——空输入必须回退默认而非 untitled,故先判 `raw.trim()===''`。测试用例覆盖此点;若实现顺序不同请以测试为准调整。

- [ ] **Step 4: App.svelte 加载** — `loadOutlineGate()` 调用处同排加:

```ts
import { loadOutlineDirs } from './lib/outline/dirs.svelte'
// …在 await loadOutlineGate() 之后:
await loadOutlineDirs()
```

- [ ] **Step 5: 设置 UI** — `SettingsDialog.svelte` outline-notes tab(快捷键区之后)追加一节:

```svelte
<h3>{t('outline.dirsTitle')}</h3>
<div class="field-row">
  <label for="wikipage-dir">{t('outline.wikipageDir')}</label>
  <input id="wikipage-dir" type="text" value={outlineDirs.wikipage}
    onchange={(e) => void setOutlineDir('wikipage', (e.currentTarget as HTMLInputElement).value)} />
</div>
<div class="field-row">
  <label for="dailynote-dir">{t('outline.dailynoteDir')}</label>
  <input id="dailynote-dir" type="text" value={outlineDirs.dailynote}
    onchange={(e) => void setOutlineDir('dailynote', (e.currentTarget as HTMLInputElement).value)} />
</div>
```

(import `outlineDirs, setOutlineDir` from `../lib/outline/dirs.svelte`;`field-row`/`h3` 样式类沿用该 tab 现有写法——先读现有区块,класс名以现状为准。)

- [ ] **Step 6: i18n** — en:`'outline.dirsTitle': 'Vault folders'`、`'outline.wikipageDir': 'Wiki pages folder'`、`'outline.dailynoteDir': 'Daily notes folder'`;zh:`'Vault 目录'`、`'Wiki 页面目录'`、`'每日笔记目录'`;ja:`'Vault フォルダ'`、`'Wiki ページフォルダ'`、`'デイリーノートフォルダ'`。

- [ ] **Step 7:** `pnpm check && pnpm test` → 全绿

- [ ] **Step 8: Commit**

```bash
git add src/lib/outline/dirs.svelte.ts src/lib/outline/dirs.test.ts src/App.svelte src/components/SettingsDialog.svelte src/lib/i18n
git commit -m "feat(outline): configurable wikipage/dailynote dir names + settings UI"
```

---

### Task 2: resolveTarget — 独立笔记可为链接目标 + 文件名碰撞检测

**Files:**
- Modify: `src/lib/outline/backlinks.ts`
- Test: `src/lib/outline/backlinks.test.ts`

- [ ] **Step 1: 写失败测试** — `backlinks.test.ts` 追加:

```ts
import { createIndex, indexFileContent, resolveTarget, detectNameCollisions } from './backlinks'

function idxWith(files: Record<string, string>) {
  const idx = createIndex()
  for (const [p, c] of Object.entries(files)) indexFileContent(idx, p, c)
  return idx
}

describe('resolveTarget', () => {
  it('resolves plain .md by filename (case-insensitive)', () => {
    const idx = idxWith({ '/v/Foo.md': 'x' })
    expect(resolveTarget(idx, 'foo')).toBe('/v/Foo.md')
  })
  it('standalone .note.md IS a valid target (wiki page)', () => {
    const idx = idxWith({ '/v/wikipage/wiki.note.md': '- x' })
    expect(resolveTarget(idx, 'wiki')).toBe('/v/wikipage/wiki.note.md')
  })
  it('companion .note.md is NEVER a target; main doc wins', () => {
    const idx = idxWith({ '/v/a.md': 'x', '/v/a.note.md': '- anno' })
    expect(resolveTarget(idx, 'a')).toBe('/v/a.md')
  })
  it('main doc beats a同名 standalone note in another dir', () => {
    const idx = idxWith({ '/v/sub/x.md': 'x', '/v/wikipage/x.note.md': '- x' })
    expect(resolveTarget(idx, 'x')).toBe('/v/sub/x.md')
  })
  it('null when nothing matches', () => {
    expect(resolveTarget(idxWith({}), 'nope')).toBeNull()
  })
})

describe('detectNameCollisions', () => {
  it('reports same page name in different dirs', () => {
    const idx = idxWith({ '/v/a/x.md': '1', '/v/b/x.md': '2' })
    const m = detectNameCollisions(idx)
    expect(m.get('x')).toEqual(expect.arrayContaining(['/v/a/x.md', '/v/b/x.md']))
  })
  it('companion pair is NOT a collision', () => {
    const idx = idxWith({ '/v/a.md': '1', '/v/a.note.md': '- x' })
    expect(detectNameCollisions(idx).size).toBe(0)
  })
  it('standalone note vs md with same name IS a collision', () => {
    const idx = idxWith({ '/v/sub/x.md': '1', '/v/wikipage/x.note.md': '- x' })
    expect(detectNameCollisions(idx).get('x')).toHaveLength(2)
  })
})
```

- [ ] **Step 2:** `pnpm vitest run src/lib/outline/backlinks.test.ts` → FAIL

- [ ] **Step 3: 实现** — `backlinks.ts` 追加(纯函数,置于 `pageCandidates` 附近):

```ts
/** p 是否为"伴生笔记"(同目录存在同名主文档,均已入索引) */
function isCompanionIn(idx: BacklinkIndex, p: string): boolean {
  return /\.notes?\.md$/i.test(p) && idx.filePages.has(p.replace(/\.notes?\.md$/i, '.md'))
}

/**
 * [[target]] → 文件路径(spec §5,file-over-app 修订):只按文件名(大小写不敏感)。
 * 主文档(.md)优先;独立 .note.md(wiki 页)可为目标;伴生 .note.md 永不为目标。
 * 无命中返回 null。
 */
export function resolveTarget(idx: BacklinkIndex, target: string): string | null {
  const t = target.toLowerCase()
  const hits = [...idx.filePages.entries()].filter(([, page]) => page.toLowerCase() === t)
  if (hits.length === 0) return null
  const md = hits.find(([p]) => !/\.notes?\.md$/i.test(p))
  if (md) return md[0]
  const standalone = hits.find(([p]) => !isCompanionIn(idx, p))
  return standalone ? standalone[0] : null
}

/**
 * 文件名碰撞检测(spec §5):同一链接名被多个文件竞争(伴生笔记不算,
 * 它与主文档同名是格式约定)。返回 小写页名 → 冲突文件列表(仅 >1 时收录)。
 */
export function detectNameCollisions(idx: BacklinkIndex): Map<string, string[]> {
  const byName = new Map<string, string[]>()
  for (const [p, page] of idx.filePages.entries()) {
    if (isCompanionIn(idx, p)) continue
    const key = page.toLowerCase()
    byName.set(key, [...(byName.get(key) ?? []), p])
  }
  const out = new Map<string, string[]>()
  for (const [k, v] of byName) if (v.length > 1) out.set(k, v)
  return out
}
```

- [ ] **Step 4:** `pnpm vitest run src/lib/outline/backlinks.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/backlinks.ts src/lib/outline/backlinks.test.ts
git commit -m "feat(outline): resolveTarget + filename collision detection (standalone notes linkable)"
```

---

### Task 3: 索引根升级 vault + 碰撞 toast + wikipage 建页

**Files:**
- Modify: `src/lib/outline/backlinks-io.svelte.ts`
- Modify: `src/lib/outline/create.ts`(`ensureOutlineFile` 支持显式 title)
- Test: `src/lib/outline/create.test.ts`(title 参数)
- Modify: `src/lib/i18n/en.ts`、`zh.ts`、`ja.ts`(碰撞文案)

- [ ] **Step 1: 写失败测试** — `create.test.ts` 追加:

```ts
  it('newOutlineFileText keeps raw title even when filename would differ', () => {
    const text = newOutlineFileText('a/b 原始标题', '2026-07-10T09:00:00.000Z')
    expect(text).toContain('title: a/b 原始标题')
  })
```

(该断言只验证 title 原样入 fm——`touchFrontmatter` 已保证;若 yaml 对含 `/` 的值加引号导致断言失败,改断言为 `toContain('a/b 原始标题')`。)

- [ ] **Step 2: create.ts** — `ensureOutlineFile` 加可选 title:

```ts
/** 确保 .note.md 存在(不存在则以空大纲创建)。title 缺省取文件名;
 *  wikipage 建页传原始标题(spec §5:文件名 slug 化、fm title 存原文)。 */
export async function ensureOutlineFile(path: string, title?: string): Promise<string> {
  const { exists, writeTextFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path).catch(() => false))) {
    await writeTextFile(path, newOutlineFileText(title ?? pageNameOf(path)))
  }
  return path
}
```

- [ ] **Step 3: backlinks-io 升级** — 整体改造:

```ts
// 顶部新增 import
import { sotvaultStore } from '../sotvault.svelte'
import { isUnder } from '../recent-merge'
import { outlineDirs } from './dirs.svelte'
import { sanitizeFileName } from './slug'
import { resolveTarget, detectNameCollisions } from './backlinks'  // 并入现有 import
import { joinPath } from '../fs'
import { ensureOutlineFile } from './create'

/** 索引根(spec §5):文件在 vault 内 → vault 根(全局命名空间);
 *  否则维持现状(FolderView 根 → 文件所在目录)。 */
function indexRootFor(path: string): string {
  const vault = sotvaultStore.vaultRoot
  if (vault && isUnder(path, vault)) return vault
  return folderView.rootDir ?? parentDir(path)
}
```

`ensureIndex(mainPath)` 中 `const root = folderView.rootDir ?? parentDir(mainPath)` 改为 `const root = indexRootFor(mainPath)`。
构建完成设置 `outline.backlinkIndex = idx; bump()` 之后追加碰撞上报:

```ts
  const collisions = detectNameCollisions(idx)
  if (collisions.size > 0) {
    const [name, files] = [...collisions.entries()][0]
    pushToast({ level: 'warn', message: t('outline.nameCollision', {
      n: String(collisions.size), name, files: files.join('\n') }) })
    console.warn('[outline] name collisions:', Object.fromEntries(collisions))
  }
```

`openPageOrCreate` 重写:

```ts
/** 点击 [[页面]]:全局解析(resolveTarget);未解析 → vault 内建 wikipage
 *  大纲页,vault 外维持旧行为(同目录建 .md)。 */
export async function openPageOrCreate(target: string): Promise<void> {
  const idx = outline.backlinkIndex
  const existing = idx ? (resolveTarget(idx, target) ?? resolveTarget(idx, sanitizeFileName(target))) : null
  if (existing) { await openFile(existing); return }
  const safe = sanitizeFileName(target)
  const docPath = outline.docPath
  const vault = sotvaultStore.vaultRoot
  if (vault && docPath && isUnder(docPath, vault)) {
    // spec §5:vault 内未解析链接 → vault/{wikipage}/{slug}.note.md,fm title 存原文
    const { mkdir } = await import('@tauri-apps/plugin-fs')
    const dir = joinPath(vault, outlineDirs.wikipage)
    await mkdir(dir, { recursive: true }).catch(() => {})
    const path = joinPath(dir, `${safe}.note.md`)
    await ensureOutlineFile(path, target)
    await openFile(path)
    return
  }
  // vault 外:维持现状(同目录建 .md)
  const dir = indexedRoot ?? (docPath ? parentDir(docPath) : null)
  if (!dir) return
  const path = joinPath(dir, `${safe}.md`)
  const { exists, writeTextFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path).catch(() => false))) {
    await writeTextFile(path, `# ${safe}\n`)
  }
  await openFile(path)
}
```

(旧的 `[...idx.filePages.entries()].find(...)` 内联解析删除,统一走 `resolveTarget`。`currentPageName` 若仍无消费者,顺手删除该死导出;同删 store 的 `isEffectivelyEmpty` 及其测试——二期终审遗留清理。若删除引发任何引用报错则保留并在报告说明。)

- [ ] **Step 4: i18n** — en:`'outline.nameCollision': '{n} link-name collision(s) in vault. "{name}" is claimed by:\n{files}'`;zh:`'outline.nameCollision': 'vault 内有 {n} 组链接名冲突。「{name}」被以下文件竞争:\n{files}'`;ja:`'outline.nameCollision': 'vault 内で {n} 件のリンク名衝突。「{name}」は以下のファイルで競合:\n{files}'`。

- [ ] **Step 5:** `pnpm check && pnpm test` → 全绿

- [ ] **Step 6: Commit**

```bash
git add src/lib/outline/backlinks-io.svelte.ts src/lib/outline/create.ts src/lib/outline/create.test.ts src/lib/outline/backlinks.ts src/lib/outline/store.svelte.ts src/lib/outline/store.test.ts src/lib/i18n
git commit -m "feat(outline): vault-wide link namespace, collision toast, wikipage creation"
```

---

### Task 4: 三期回归

- [ ] `pnpm check` → 0 errors;`pnpm test` → 全过
- [ ] Commit(如有零星修正)。dev 实机验证与四期合并进行(四期 plan Task 3)。

---

## Self-Review 结果

- **Spec 覆盖:** §5 索引根 vault(Task 3 indexRootFor)、按文件名全局解析+独立笔记可为目标(Task 2 resolveTarget)、碰撞 toast 不自动改名不阻塞(Task 2 检测 + Task 3 上报)、未解析建页 vault/{wikipage}/{slug}.note.md + fm 原始标题(Task 3 + create.ts title 参数)、vault 外维持现状(Task 3 else 分支)。§6 目录名配置+默认值+设置 UI(Task 1)。
- **占位符:** 无。
- **类型一致性:** `outlineDirs.wikipage`(Task 1)在 Task 3 消费;`ensureOutlineFile(path, title?)`(Task 3 Step 2)与调用一致;`resolveTarget/detectNameCollisions`(Task 2)与 Task 3 import 一致。
