# `.note.md` 基础功能升级 — 第一期:格式与后缀 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 伴生大纲后缀统一为 `.note.md`(存量 `.notes.md` 自动迁移),大纲文件获得 YAML front-matter(title/created/updated)读写能力。

**Architecture:** 纯函数层(路径推导、front-matter 解析/序列化/补齐)全部单测;IO 层(迁移改名、flushSave 集成)保持薄、走仓库惯例的手动验证。`OutlineTree` 增加 `frontmatter` 字段随树携带,序列化时原样回写,`yaml` 包(已有依赖)做键级 upsert 以保留未知键与顺序。

**Tech Stack:** TypeScript + Svelte 5、vitest、`yaml`、`@tauri-apps/plugin-fs`(`rename`/`stat`)

**Spec:** `docs/superpowers/specs/2026-07-10-outline-note-base-design.md` §1、§2

**后续:** 第二~四期(大纲 tab / vault 索引 / dailynote)各自单独出计划,待前一期合入后编写。

---

### Task 1: companionPathFor 后缀统一为 `.note.md`

**Files:**
- Modify: `src/lib/outline/store.svelte.ts:50-54`
- Test: `src/lib/outline/store.test.ts:6-15`

- [ ] **Step 1: 改写现有测试为新后缀,并新增旧后缀识别断言**

替换 `store.test.ts` 中 `describe('companionPathFor', ...)` 整块:

```ts
describe('companionPathFor', () => {
  it('maps main file to sibling .note.md', () => {
    expect(companionPathFor('/d/foo.md')).toBe('/d/foo.note.md')
    expect(companionPathFor('/d/bar.markdown')).toBe('/d/bar.note.md')
  })
  it('null for companion files themselves (new and legacy suffix) and non-md', () => {
    expect(companionPathFor('/d/foo.note.md')).toBeNull()
    expect(companionPathFor('/d/foo.notes.md')).toBeNull()
    expect(companionPathFor('/d/FOO.NOTE.MD')).toBeNull()
    expect(companionPathFor('/d/x.png')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/store.test.ts`
Expected: FAIL — `'/d/foo.notes.md'` ≠ `'/d/foo.note.md'`

- [ ] **Step 3: 实现**

`store.svelte.ts` 中 `companionPathFor` 替换为:

```ts
/** 新旧两种大纲后缀(迁移期兼容识别) */
export const OUTLINE_SUFFIX_RE = /\.notes?\.md$/i

export function companionPathFor(mainPath: string): string | null {
  if (OUTLINE_SUFFIX_RE.test(mainPath)) return null
  const m = mainPath.match(/^(.*)\.(md|markdown|mdown|mkd)$/i)
  return m ? `${m[1]}.note.md` : null
}
```

同文件 69 行注释里的 `.notes.md` 改为 `.note.md`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/store.test.ts`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/store.svelte.ts src/lib/outline/store.test.ts
git commit -m "feat(outline): companion suffix .notes.md → .note.md"
```

---

### Task 2: pageNameOf / backlinks-io 兼容新旧后缀

**Files:**
- Modify: `src/lib/outline/backlinks.ts:21`
- Modify: `src/lib/outline/backlinks-io.svelte.ts:56`
- Test: `src/lib/outline/backlinks.test.ts`

- [ ] **Step 1: 写失败测试**

在 `backlinks.test.ts` 增加(如已有 pageNameOf describe 则并入):

```ts
describe('pageNameOf', () => {
  it('strips .note.md, legacy .notes.md and plain .md', () => {
    expect(pageNameOf('/v/foo.note.md')).toBe('foo')
    expect(pageNameOf('/v/foo.notes.md')).toBe('foo')
    expect(pageNameOf('/v/foo.md')).toBe('foo')
  })
})
```

(顶部 import 补 `pageNameOf`。)

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/backlinks.test.ts`
Expected: FAIL — `pageNameOf('/v/foo.note.md')` 返回 `'foo.note'`

- [ ] **Step 3: 实现**

`backlinks.ts:21`:

```ts
export function pageNameOf(path: string): string {
  return basename(path).replace(/\.notes?\.md$/i, '').replace(/\.md$/i, '')
}
```

`backlinks-io.svelte.ts:56` 的过滤正则同步改为 `!/\.notes?\.md$/i.test(p)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/backlinks.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/backlinks.ts src/lib/outline/backlinks-io.svelte.ts src/lib/outline/backlinks.test.ts
git commit -m "feat(outline): recognise both .note.md and legacy .notes.md in backlink index"
```

---

### Task 3: OutlineTree 携带 front-matter,parse/serialize 往返保留

**Files:**
- Modify: `src/lib/outline/model.ts:31-33`
- Modify: `src/lib/outline/markdown.ts`
- Test: `src/lib/outline/markdown.test.ts`

- [ ] **Step 1: 写失败测试**

`markdown.test.ts` 新增:

```ts
describe('front-matter', () => {
  const fm = 'title: 我的笔记\ncreated: 2026-07-10T08:00:00.000Z\nroam-uid: abc'
  it('parseOutline extracts leading YAML block into tree.frontmatter', () => {
    const t = parseOutline(`---\n${fm}\n---\n- A\n`)
    expect(t.frontmatter).toBe(fm)
    expect([...t.nodes.values()].map(n => n.content)).toEqual(['A'])
  })
  it('round-trips front-matter byte-exact (unknown keys preserved)', () => {
    const md = `---\n${fm}\n---\n- A\n  - B\n`
    expect(roundTrip(md)).toBe(md)
  })
  it('no front-matter → tree.frontmatter is null, output unchanged', () => {
    const t = parseOutline('- A\n')
    expect(t.frontmatter).toBeNull()
    expect(roundTrip('- A\n')).toBe('- A\n')
  })
  it('serializes front-matter even when body is empty', () => {
    const t = parseOutline(`---\n${fm}\n---\n`)
    expect(serializeOutline(t)).toBe(`---\n${fm}\n---\n`)
  })
  it('a lone --- line in body is not front-matter', () => {
    const t = parseOutline('- A\n---\n')
    expect(t.frontmatter).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/markdown.test.ts`
Expected: FAIL — `t.frontmatter` 为 undefined,front-matter 行被当正文解析

- [ ] **Step 3: 实现**

`model.ts` 31-33 行:

```ts
export interface OutlineTree { nodes: Map<string, OutlineNode>; frontmatter: string | null }

export function createTree(): OutlineTree { return { nodes: new Map(), frontmatter: null } }
```

(`grep -rn "nodes: new Map" src/` 确认无其他 OutlineTree 字面量构造点;有则同步补 `frontmatter: null`。)

`markdown.ts` 新增导出并接入:

```ts
/** 文件头部 YAML front-matter 块。必须从第 0 字符开始,--- 独占一行。 */
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/

export function splitFrontmatterBlock(text: string): { frontmatter: string | null; body: string } {
  const m = text.match(FM_RE)
  return m ? { frontmatter: m[1], body: text.slice(m[0].length) } : { frontmatter: null, body: text }
}
```

`parseOutline` 开头改为:

```ts
export function parseOutline(text: string): OutlineTree {
  const tree = createTree()
  const { frontmatter, body } = splitFrontmatterBlock(text)
  tree.frontmatter = frontmatter
  // …以下原有按行解析逻辑,把输入源从 text 换成 body,其余不动…
```

`serializeOutline` 的 `const lines: string[] = []` 之后插入:

```ts
if (tree.frontmatter != null) lines.push('---', tree.frontmatter, '---')
```

- [ ] **Step 4: 跑测试确认通过(含既有往返用例不回归)**

Run: `pnpm vitest run src/lib/outline/markdown.test.ts src/lib/outline/model.test.ts src/lib/outline/sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/model.ts src/lib/outline/markdown.ts src/lib/outline/markdown.test.ts
git commit -m "feat(outline): YAML front-matter round-trip in outline files"
```

---

### Task 4: touchFrontmatter — 补齐/刷新 title、created、updated

**Files:**
- Create: `src/lib/outline/frontmatter.ts`
- Test: `src/lib/outline/frontmatter.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `frontmatter.test.ts`:

```ts
// src/lib/outline/frontmatter.test.ts
import { describe, it, expect } from 'vitest'
import { touchFrontmatter, fmHas } from './frontmatter'

const NOW = '2026-07-10T09:00:00.000Z'

describe('touchFrontmatter', () => {
  it('builds full front-matter from null', () => {
    const out = touchFrontmatter(null, { title: '我的笔记', now: NOW })
    expect(out).toContain('title: 我的笔记')
    expect(out).toContain(`created: ${NOW}`)
    expect(out).toContain(`updated: ${NOW}`)
  })
  it('keeps existing title/created, refreshes updated, preserves unknown keys', () => {
    const raw = 'title: 旧标题\ncreated: 2020-01-01T00:00:00.000Z\nupdated: 2020-01-02T00:00:00.000Z\nroam-uid: abc'
    const out = touchFrontmatter(raw, { title: '新标题', now: NOW })
    expect(out).toContain('title: 旧标题')
    expect(out).toContain('created: 2020-01-01T00:00:00.000Z')
    expect(out).toContain(`updated: ${NOW}`)
    expect(out).toContain('roam-uid: abc')
  })
  it('uses provided created fallback when missing', () => {
    const out = touchFrontmatter('title: t', { title: 't', created: '2019-05-05T00:00:00.000Z', now: NOW })
    expect(out).toContain('created: 2019-05-05T00:00:00.000Z')
  })
  it('leaves non-mapping front-matter untouched (conservative)', () => {
    const raw = 'just some prose'
    expect(touchFrontmatter(raw, { title: 't', now: NOW })).toBe(raw)
  })
})

describe('fmHas', () => {
  it('detects top-level keys', () => {
    expect(fmHas('title: x\ncreated: y', 'created')).toBe(true)
    expect(fmHas('title: x', 'created')).toBe(false)
    expect(fmHas(null, 'title')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/frontmatter.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

新建 `frontmatter.ts`:

```ts
// src/lib/outline/frontmatter.ts
import { parseDocument, isMap } from 'yaml'

export interface TouchOpts {
  /** 缺 title 时写入的标题(原始标题,未 slug 化) */
  title: string
  /** 缺 created 时的回退值(通常取文件 birthtime);不传用 now */
  created?: string
  /** 注入时间,便于测试;默认当前时间 ISO 8601 */
  now?: string
}

/** front-matter 是否含顶层键(raw 为 --- 分隔符之间的内容,不含分隔符) */
export function fmHas(raw: string | null, key: string): boolean {
  if (!raw) return false
  const doc = parseDocument(raw)
  return doc.contents != null && isMap(doc.contents) && doc.has(key)
}

/**
 * 补齐/刷新 front-matter:title、created 缺失时补上,updated 总是刷新。
 * 未知键(如 roam-uid)与既有键顺序保留。非 mapping 的 front-matter
 * 原样返回,不做破坏性改写。
 */
export function touchFrontmatter(raw: string | null, opts: TouchOpts): string {
  const now = opts.now ?? new Date().toISOString()
  const doc = parseDocument(raw ?? '')
  if (doc.contents == null) doc.contents = doc.createNode({}) as never
  else if (!isMap(doc.contents)) return raw ?? ''
  if (!doc.has('title')) doc.set('title', opts.title)
  if (!doc.has('created')) doc.set('created', opts.created ?? now)
  doc.set('updated', now)
  return doc.toString().replace(/\n$/, '')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/outline/frontmatter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/frontmatter.ts src/lib/outline/frontmatter.test.ts
git commit -m "feat(outline): touchFrontmatter — upsert title/created/updated preserving unknown keys"
```

---

### Task 5: flushSave 落盘时补齐/刷新 front-matter

**Files:**
- Modify: `src/lib/outline/store.svelte.ts:170-186`(`flushSave`)

IO 集成,仓库惯例 vitest 不覆盖,走 Task 7 手动验证。

- [ ] **Step 1: 实现**

`flushSave` 中 `isEffectivelyEmpty` 判空之后、`serializeOutline` 之前插入(保持判空在前,避免给从未编辑过的幽灵伴生文件建 front-matter):

```ts
  const { touchFrontmatter, fmHas } = await import('./frontmatter')
  let created: string | undefined
  if (!fmHas(outline.tree.frontmatter, 'created')) {
    const { stat } = await import('@tauri-apps/plugin-fs')
    const info = await stat(path).catch(() => null)
    created = info?.birthtime ? new Date(info.birthtime).toISOString() : undefined
  }
  const { pageNameOf } = await import('./backlinks')
  outline.tree.frontmatter = touchFrontmatter(outline.tree.frontmatter, {
    title: pageNameOf(path),
    created,
  })
```

- [ ] **Step 2: 类型检查 + 全量单测无回归**

Run: `pnpm check && pnpm vitest run src/lib/outline`
Expected: 均 PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/outline/store.svelte.ts
git commit -m "feat(outline): stamp front-matter (title/created/updated) on companion save"
```

---

### Task 6: 存量 `.notes.md` 自动迁移(打开时 + 索引构建时)

**Files:**
- Create: `src/lib/outline/migrate.ts`
- Test: `src/lib/outline/migrate.test.ts`
- Modify: `src/lib/outline/store.svelte.ts`(`attachTab`)
- Modify: `src/lib/outline/backlinks.ts:73-92`(`buildFolderIndex`)
- Modify: `src/lib/outline/backlinks-io.svelte.ts`(传入冲突回调)
- Modify: `src/lib/i18n/en.ts`、`src/lib/i18n/zh.ts`(冲突提示文案)

- [ ] **Step 1: 写失败测试(纯路径推导部分)**

新建 `migrate.test.ts`:

```ts
// src/lib/outline/migrate.test.ts
import { describe, it, expect } from 'vitest'
import { legacyCompanionPathFor, migratedPathFor } from './migrate'

describe('legacyCompanionPathFor', () => {
  it('maps main file to sibling legacy .notes.md', () => {
    expect(legacyCompanionPathFor('/d/foo.md')).toBe('/d/foo.notes.md')
  })
  it('null for companion files and non-md', () => {
    expect(legacyCompanionPathFor('/d/foo.note.md')).toBeNull()
    expect(legacyCompanionPathFor('/d/x.png')).toBeNull()
  })
})

describe('migratedPathFor', () => {
  it('rewrites legacy suffix to .note.md (case-insensitive)', () => {
    expect(migratedPathFor('/d/foo.notes.md')).toBe('/d/foo.note.md')
    expect(migratedPathFor('/d/FOO.NOTES.MD')).toBe('/d/FOO.note.md')
  })
  it('null for non-legacy paths', () => {
    expect(migratedPathFor('/d/foo.note.md')).toBeNull()
    expect(migratedPathFor('/d/foo.md')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/outline/migrate.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 migrate.ts**

```ts
// src/lib/outline/migrate.ts
import { companionPathFor } from './store.svelte'

/** xxx.md 的旧后缀伴生路径(仅迁移期使用) */
export function legacyCompanionPathFor(mainPath: string): string | null {
  const target = companionPathFor(mainPath)
  return target ? target.replace(/\.note\.md$/, '.notes.md') : null
}

/** 任意 *.notes.md 路径的新后缀目标;非旧后缀返回 null */
export function migratedPathFor(legacyPath: string): string | null {
  return /\.notes\.md$/i.test(legacyPath)
    ? legacyPath.replace(/\.notes\.md$/i, '.note.md')
    : null
}

/** 就地重命名单个旧后缀文件(git 可追溯,无备份副本)。 */
export async function migrateLegacyFile(
  legacyPath: string,
): Promise<'renamed' | 'conflict' | 'none'> {
  const target = migratedPathFor(legacyPath)
  if (!target) return 'none'
  const { exists, rename } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(legacyPath).catch(() => false))) return 'none'
  if (await exists(target).catch(() => false)) return 'conflict'
  try {
    await rename(legacyPath, target)
    return 'renamed'
  } catch (e) {
    console.warn('[outline] migrate failed:', legacyPath, e)
    return 'none'
  }
}

/** 打开 xxx.md 时:若存在旧后缀伴生文件则先迁移(目标已存在则保留双份,索引期报告) */
export async function migrateLegacyCompanion(mainPath: string): Promise<void> {
  const legacy = legacyCompanionPathFor(mainPath)
  if (legacy) await migrateLegacyFile(legacy)
}
```

Run: `pnpm vitest run src/lib/outline/migrate.test.ts`
Expected: PASS

- [ ] **Step 4: attachTab 接入(打开时迁移)**

`store.svelte.ts` `attachTab` 中,`if (syncTimer) …` 行之后、`outline.mainPath = mainPath` 之前插入:

```ts
  // 旧后缀伴生文件就地迁移(在读伴生文件之前)
  const { migrateLegacyCompanion } = await import('./migrate')
  await migrateLegacyCompanion(mainPath)
  if (token !== attachSeq) return
```

(migrate.ts 静态导入 store.svelte.ts、store 动态导入 migrate,无循环初始化问题。)

- [ ] **Step 5: buildFolderIndex 接入(索引构建时迁移 + 冲突回调)**

`backlinks.ts` `buildFolderIndex` 签名与 walk 内文件分支改为:

```ts
export async function buildFolderIndex(
  rootDir: string,
  onMigrateConflict?: (legacyPath: string) => void,
): Promise<BacklinkIndex> {
  const { readDir, readTextFile, stat } = await import('@tauri-apps/plugin-fs')
  const idx = createIndex()
  const walk = async (dir: string): Promise<void> => {
    const entries = await readDir(dir).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isSymlink) continue // skip symlinks to avoid cycle risk
      let path = joinPath(dir, e.name)
      if (e.isDirectory) { await walk(path); continue }
      if (!/\.md$/i.test(e.name)) continue
      if (/\.notes\.md$/i.test(e.name)) {
        const { migrateLegacyFile, migratedPathFor } = await import('./migrate')
        const r = await migrateLegacyFile(path)
        if (r === 'renamed') path = migratedPathFor(path)!
        else if (r === 'conflict') onMigrateConflict?.(path)
      }
      const info = await stat(path).catch(() => null)
      if (info && info.size > MAX_FILE_BYTES) continue
      const content = await readTextFile(path).catch(() => null)
      if (content != null) indexFileContent(idx, path, content)
    }
  }
  await walk(rootDir)
  return idx
}
```

`backlinks-io.svelte.ts` 中调用 `buildFolderIndex(root)` 处改为:

```ts
buildFolderIndex(root, (legacyPath) => {
  pushToast({ level: 'warning', message: t('outline.migrate.conflict', { path: legacyPath }) })
})
```

(按该文件既有 import 习惯引入 `pushToast` 与 `t`;若 toast level 枚举无 `warning` 则用 `error`,以现有 `src/lib/toast.svelte.ts` 类型为准。)

i18n:`en.ts` 增加

```ts
'outline.migrate.conflict': 'Legacy note not migrated (target exists): {path}',
```

`zh.ts` 增加

```ts
'outline.migrate.conflict': '旧后缀笔记未迁移(新文件已存在):{path}',
```

- [ ] **Step 6: 类型检查 + 全量单测**

Run: `pnpm check && pnpm test`
Expected: 均 PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/outline/migrate.ts src/lib/outline/migrate.test.ts src/lib/outline/store.svelte.ts src/lib/outline/backlinks.ts src/lib/outline/backlinks-io.svelte.ts src/lib/i18n/en.ts src/lib/i18n/zh.ts
git commit -m "feat(outline): auto-migrate legacy .notes.md → .note.md on open and index build"
```

---

### Task 7: 全量回归 + dev 实机验证

**Files:** 无新改动(验证任务)

- [ ] **Step 1: 全量检查**

Run: `pnpm check && pnpm test`
Expected: 均 PASS

- [ ] **Step 2: dev 实机验证(GUI/文件行为改动,按仓库惯例必须做)**

按 `reference_dev_gui_verification` 流程(dev 构建 + `/tmp/mdeditor.log` + screencapture),验证清单:

1. 准备 `/tmp/nvtest/a.md` 与旧后缀 `/tmp/nvtest/a.notes.md`(手写几行 `- item`);
   在 app 中打开 `a.md` → 磁盘上 `a.notes.md` 被改名为 `a.note.md`,大纲面板正常显示内容
2. 在面板中编辑任一节点触发保存 → `a.note.md` 头部出现 front-matter:
   `title: a`、`created`(≈文件 birthtime)、`updated`(当前时间);
   再次编辑保存 → `updated` 刷新,`title`/`created` 不变
3. 打开无伴生文件的 `b.md`,不做任何大纲编辑 → 不产生 `b.note.md`(幽灵文件守卫仍有效)
4. 同时存在 `c.notes.md` 与 `c.note.md` 时打开文件夹视图触发索引 → 弹冲突 toast,两个文件都未被动改动
5. 带 front-matter 的 `.note.md` 用系统文本编辑器查看 → `---` 块 + `- ` 列表,纯文本可读

- [ ] **Step 3: 提交验证记录(如有截图/日志要点写入 commit message 或 PR 描述)**

```bash
git add -A
git commit -m "chore(outline): phase-1 verification notes" --allow-empty
```

---

## Self-Review 结果

- **Spec 覆盖:** §1 后缀统一(Task 1/2)、迁移双路径(Task 6)、遗留兼容识别(Task 1/2 的 `notes?` 正则);§2 front-matter 往返(Task 3)、补齐策略与 birthtime 回退(Task 4/5)、纯文本可读(Task 7 验证项 5)。§2 "新建笔记生成完整 front-matter"属第二/四期创建流程,不在本期。
- **占位符:** 无 TBD/TODO;parseOutline 的"其余不动"指明了唯一改动点(输入源换成 `body`),非占位。
- **类型一致性:** `OutlineTree.frontmatter: string | null` 贯穿 Task 3/4/5;`migrateLegacyFile` 返回联合类型在 Task 6 两处调用一致。
