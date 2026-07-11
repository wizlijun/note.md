# Roam Research 导入插件(一期)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** builtin 插件 + 独立窗口,把 Roam Research 全量 JSON 导出转换为 vault 内 dailynote/wikipage 的 `.note.md`,支持 uid 清单增量重导。

**Architecture:** 转换核心为 `src/lib/roam-import/` 纯函数(parse → syntax → convert → plan),仅被独立窗口入口 `roam-import.html` 引用;插件门面 `src-tauri/plugins/roam-import/manifest.json`(`kind:"builtin"`, 默认关);Rust 命令 `show_roam_import_window` 建窗;App.svelte 的 `dispatchPlugin` 加分支。

**Tech Stack:** Svelte 5 runes、Tauri 2、vitest、fflate(zip 解包,仅进本窗口 bundle)。

**Worktree:** 一切操作在 `/Users/bruce/git/mdeditor/.worktrees/roam-import`(分支 `feature/roam-import`)。spec: `docs/superpowers/specs/2026-07-11-roam-import-design.md`。

---

### Task 0: Worktree 依赖就绪

**Files:** 无代码改动。

- [ ] **Step 0.1: moraya-core 软链**(`file:../moraya-core` 相对 worktree 根解析到 `.worktrees/moraya-core`)

```bash
ln -sfn /Users/bruce/git/moraya-core /Users/bruce/git/mdeditor/.worktrees/moraya-core
```

- [ ] **Step 0.2: 安装依赖 + 加 fflate**

```bash
cd /Users/bruce/git/mdeditor/.worktrees/roam-import
pnpm install
pnpm add fflate
```

- [ ] **Step 0.3: 基线验证**

Run: `pnpm check && pnpm test`
Expected: 全绿(worktree 基于 main 5a2cdb5,应干净)。

- [ ] **Step 0.4: Commit**(只 add package.json + pnpm-lock.yaml)

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(roam-import): add fflate for zip unpacking"
```

---

### Task 1: types + parse — Roam JSON → 内部模型

**Files:**
- Create: `src/lib/roam-import/types.ts`
- Create: `src/lib/roam-import/parse.ts`
- Test: `src/lib/roam-import/parse.test.ts`

- [ ] **Step 1.1: 写 types.ts**(无测试,纯类型)

```ts
// src/lib/roam-import/types.ts
/** Roam JSON 导出的 block(递归)。未列出的键(text-align、emojis 等)忽略。 */
export interface RoamBlock {
  uid?: string
  string?: string
  heading?: number
  children?: RoamBlock[]
  'create-time'?: number
  'edit-time'?: number
}

/** Roam JSON 导出的页面。顶层就是 RoamPage[]。 */
export interface RoamPage {
  title: string
  uid?: string
  children?: RoamBlock[]
  'create-time'?: number
  'edit-time'?: number
}

export interface RoamGraph {
  pages: RoamPage[]
  /** 全图被 ((uid)) 引用到的 uid(含 embed 内),这些 block 落盘时必须写 id:: */
  referencedUids: Set<string>
}

/** 增量清单,存 vault/.notemd/roam-import.json */
export interface ImportManifest {
  graphName: string
  importedAt: string
  pages: Record<string, { file: string; editTime: number; contentHash: string }>
}

/** 页面清单键:有 uid 用 uid,否则退回标题 */
export function pageKey(p: RoamPage): string {
  return p.uid ?? `t:${p.title}`
}
```

- [ ] **Step 1.2: 写失败测试**

```ts
// src/lib/roam-import/parse.test.ts
import { describe, it, expect } from 'vitest'
import { parseRoamJson, dailyDateFromUid } from './parse'

const G = JSON.stringify([
  {
    title: 'July 11th, 2026', uid: '07-11-2026', 'edit-time': 1700000000000,
    children: [
      { uid: 'aaa111', string: 'hello ((bbb222)) world', 'edit-time': 1700000000001 },
    ],
  },
  {
    title: 'Wiki Page', uid: 'pg1',
    children: [
      { uid: 'bbb222', string: 'target block', children: [
        { uid: 'ccc333', string: '{{[[embed]]: ((ddd444))}}' },
      ] },
    ],
  },
])

describe('parseRoamJson', () => {
  it('parses pages and collects referenced uids across the whole graph', () => {
    const g = parseRoamJson(G)
    expect(g.pages).toHaveLength(2)
    expect(g.referencedUids).toEqual(new Set(['bbb222', 'ddd444']))
  })

  it('rejects non-array json', () => {
    expect(() => parseRoamJson('{"a":1}')).toThrow(/array/i)
    expect(() => parseRoamJson('not json')).toThrow()
  })

  it('skips entries without a string title', () => {
    const g = parseRoamJson('[{"title":"ok"},{"notitle":true},null]')
    expect(g.pages.map((p) => p.title)).toEqual(['ok'])
  })
})

describe('dailyDateFromUid', () => {
  it('converts Roam daily uid MM-DD-YYYY to yyyy-MM-dd', () => {
    expect(dailyDateFromUid('07-11-2026')).toBe('2026-07-11')
  })
  it('rejects non-daily uids and out-of-range dates', () => {
    expect(dailyDateFromUid('aaa111')).toBeNull()
    expect(dailyDateFromUid(undefined)).toBeNull()
    expect(dailyDateFromUid('13-01-2026')).toBeNull()
    expect(dailyDateFromUid('12-32-2026')).toBeNull()
  })
})
```

- [ ] **Step 1.3: 跑测试确认失败**

Run: `pnpm vitest run src/lib/roam-import/parse.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 1.4: 实现 parse.ts**

```ts
// src/lib/roam-import/parse.ts
import type { RoamBlock, RoamPage, RoamGraph } from './types'

const REF_RE = /\(\(([a-zA-Z0-9_-]{3,})\)\)/g
const DAILY_UID_RE = /^(\d{2})-(\d{2})-(\d{4})$/

/** Roam 日记页判定走 uid(MM-DD-YYYY),不解析英文标题。返回 yyyy-MM-dd 或 null。 */
export function dailyDateFromUid(uid: string | undefined): string | null {
  const m = uid?.match(DAILY_UID_RE)
  if (!m) return null
  const mm = Number(m[1]), dd = Number(m[2])
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
  return `${m[3]}-${m[1]}-${m[2]}`
}

function collectRefs(blocks: RoamBlock[] | undefined, acc: Set<string>): void {
  for (const b of blocks ?? []) {
    if (typeof b?.string === 'string') {
      for (const m of b.string.matchAll(REF_RE)) acc.add(m[1])
    }
    collectRefs(b?.children, acc)
  }
}

/** 解析 Roam JSON 导出全文。非数组/坏 JSON 抛错;无 title 的条目跳过。 */
export function parseRoamJson(text: string): RoamGraph {
  const data: unknown = JSON.parse(text)
  if (!Array.isArray(data)) throw new Error('Roam export must be a JSON array of pages')
  const pages: RoamPage[] = []
  const referencedUids = new Set<string>()
  for (const entry of data) {
    const p = entry as RoamPage | null
    if (p == null || typeof p.title !== 'string') continue
    pages.push(p)
    collectRefs(p.children, referencedUids)
  }
  return { pages, referencedUids }
}
```

- [ ] **Step 1.5: 跑测试确认通过**

Run: `pnpm vitest run src/lib/roam-import/parse.test.ts`
Expected: PASS。

- [ ] **Step 1.6: Commit**

```bash
git add src/lib/roam-import/types.ts src/lib/roam-import/parse.ts src/lib/roam-import/parse.test.ts
git commit -m "feat(roam-import): parse Roam JSON export into internal model"
```

---

### Task 2: syntax — 字符串级语法转换

**Files:**
- Create: `src/lib/roam-import/syntax.ts`
- Test: `src/lib/roam-import/syntax.test.ts`

- [ ] **Step 2.1: 写失败测试**

```ts
// src/lib/roam-import/syntax.test.ts
import { describe, it, expect } from 'vitest'
import { convertInline, rewriteLinks, escapeReservedProps } from './syntax'

describe('convertInline', () => {
  it('converts TODO/DONE markers', () => {
    expect(convertInline('{{[[TODO]]}} buy milk')).toBe('[ ] buy milk')
    expect(convertInline('{{[[DONE]]}} done it')).toBe('[x] done it')
    expect(convertInline('{{TODO}} short form')).toBe('[ ] short form')
  })
  it('degrades embeds to block refs', () => {
    expect(convertInline('{{[[embed]]: ((abc123))}}')).toBe('((abc123))')
    expect(convertInline('{{embed: ((abc123))}}')).toBe('((abc123))')
  })
  it('converts __italic__ to *italic*', () => {
    expect(convertInline('a __word__ b')).toBe('a *word* b')
  })
  it('converts #[[multi word]] tags to wikilinks, keeps #plain tags', () => {
    expect(convertInline('x #[[multi word]] y #plain')).toBe('x [[multi word]] y #plain')
  })
  it('keeps bold/highlight/strike/wikilinks/block refs as-is', () => {
    const s = '**b** ^^h^^ ~~s~~ [[Page]] ((abc123))'
    expect(convertInline(s)).toBe(s)
  })
  it('does not transform inside inline code or code fences', () => {
    expect(convertInline('`__x__` and ```\n__y__\n``` and __z__'))
      .toBe('`__x__` and ```\n__y__\n``` and *z*')
  })
})

describe('rewriteLinks', () => {
  it('rewrites [[Old]] to [[New]] per rename map, including inside #[[...]] output', () => {
    const renames = new Map([['a/b', 'a-b']])
    expect(rewriteLinks('see [[a/b]] end', renames)).toBe('see [[a-b]] end')
    expect(rewriteLinks('see [[untouched]]', renames)).toBe('see [[untouched]]')
  })
})

describe('escapeReservedProps', () => {
  it('prefixes reserved prop-like continuation lines with a space', () => {
    expect(escapeReservedProps('first\nid:: sneaky\nnormal line'))
      .toBe('first\n id:: sneaky\nnormal line')
  })
  it('leaves first line and non-reserved keys alone', () => {
    expect(escapeReservedProps('id:: first-line-safe\nfoo:: bar'))
      .toBe('id:: first-line-safe\nfoo:: bar')
  })
})
```

- [ ] **Step 2.2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/roam-import/syntax.test.ts`
Expected: FAIL。

- [ ] **Step 2.3: 实现 syntax.ts**

```ts
// src/lib/roam-import/syntax.ts
/** 代码段(``` fence 或 `inline`)切分:偶数下标是普通文本,奇数是代码,转换只作用于普通段 */
const CODE_SPLIT_RE = /(```[\s\S]*?```|`[^`\n]*`)/

function mapNonCode(s: string, fn: (seg: string) => string): string {
  return s.split(CODE_SPLIT_RE).map((seg, i) => (i % 2 === 0 ? fn(seg) : seg)).join('')
}

/** Roam 行内语法 → 本地 markdown(spec 语法映射表) */
export function convertInline(s: string): string {
  return mapNonCode(s, (seg) =>
    seg
      .replace(/\{\{\[\[embed\]\]:\s*\(\(([a-zA-Z0-9_-]+)\)\)\s*\}\}/g, '(($1))')
      .replace(/\{\{embed:\s*\(\(([a-zA-Z0-9_-]+)\)\)\s*\}\}/g, '(($1))')
      .replace(/\{\{\[\[TODO\]\]\}\}/g, '[ ]')
      .replace(/\{\{\[\[DONE\]\]\}\}/g, '[x]')
      .replace(/\{\{TODO\}\}/g, '[ ]')
      .replace(/\{\{DONE\}\}/g, '[x]')
      .replace(/__([^_\n](?:[^\n]*?[^_\n])?)__/g, '*$1*')
      .replace(/#\[\[([^\]\n]+)\]\]/g, '[[$1]]'),
  )
}

/** 按改名映射改写 [[链接]](wikilink 只按文件名解析,改名必须全图重链) */
export function rewriteLinks(s: string, renames: Map<string, string>): string {
  if (renames.size === 0) return s
  return mapNonCode(s, (seg) =>
    seg.replace(/\[\[([^\]\n]+)\]\]/g, (whole, t: string) => {
      const to = renames.get(t)
      return to != null ? `[[${to}]]` : whole
    }),
  )
}

/** 多行 block 里形如保留属性(parseOutline 的 PROP_RE)的续行会被当属性吃掉,
 *  前置一个空格转义(渲染等价)。首行在 `- ` 之后,天然安全。 */
const RESERVED_PROP_RE = /^(type|line|id|collapsed|created|updated):: /
export function escapeReservedProps(s: string): string {
  const lines = s.split('\n')
  return lines
    .map((ln, i) => (i > 0 && RESERVED_PROP_RE.test(ln) ? ` ${ln}` : ln))
    .join('\n')
}
```

- [ ] **Step 2.4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/roam-import/syntax.test.ts`
Expected: PASS。

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/roam-import/syntax.ts src/lib/roam-import/syntax.test.ts
git commit -m "feat(roam-import): Roam inline syntax conversion"
```

---

### Task 3: convert — RoamPage → .note.md 全文

**Files:**
- Create: `src/lib/roam-import/convert.ts`
- Test: `src/lib/roam-import/convert.test.ts`

依赖既有 API:`createTree/addNode/OutlineNode`(`../outline/model`)、`serializeOutline`(`../outline/markdown`)、`touchFrontmatter`(`../outline/frontmatter`)。

- [ ] **Step 3.1: 写失败测试**

```ts
// src/lib/roam-import/convert.test.ts
import { describe, it, expect } from 'vitest'
import { convertPage, maxEditTime } from './convert'
import type { RoamPage } from './types'

const page: RoamPage = {
  title: 'My Page', uid: 'pg1',
  'create-time': 1600000000000, 'edit-time': 1600000001000,
  children: [
    { uid: 'aaa111', string: 'parent {{[[TODO]]}} item', 'create-time': 1600000002000, 'edit-time': 1600000003000,
      children: [{ uid: 'bbb222', string: 'child', heading: 2 }] },
  ],
}

describe('convertPage', () => {
  it('produces front-matter with original title and serialized outline', () => {
    const out = convertPage(page, new Set(), new Map())
    expect(out.text).toMatch(/^---\ntitle: My Page\n/)
    expect(out.text).toContain('- parent [ ] item')
    expect(out.text).toContain('  - ## child')
    expect(out.text).toContain('created:: 2020-09-13T12:26:42.000Z')
    expect(out.text).toContain('updated:: 2020-09-13T12:26:43.000Z')
  })

  it('writes id:: only for referenced uids', () => {
    const out = convertPage(page, new Set(['bbb222']), new Map())
    expect(out.text).toContain('id:: bbb222')
    expect(out.text).not.toContain('id:: aaa111')
  })

  it('rewrites renamed links and escapes reserved props', () => {
    const p: RoamPage = { title: 'X', children: [
      { uid: 'u1', string: 'see [[a/b]]' },
      { uid: 'u2', string: 'multi\nid:: not-a-prop' },
    ] }
    const out = convertPage(p, new Set(), new Map([['a/b', 'a-b']]))
    expect(out.text).toContain('[[a-b]]')
    expect(out.text).toContain('\n   id:: not-a-prop') // 续行缩进 2 + 转义空格 1
  })

  it('empty page still yields one empty node', () => {
    const out = convertPage({ title: 'Empty' }, new Set(), new Map())
    expect(out.text).toMatch(/---\n- \n$/)
  })
})

describe('maxEditTime', () => {
  it('takes the max across page and all blocks', () => {
    expect(maxEditTime(page)).toBe(1600000003000)
    expect(maxEditTime({ title: 'x' })).toBe(0)
  })
})
```

- [ ] **Step 3.2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/roam-import/convert.test.ts`
Expected: FAIL。

- [ ] **Step 3.3: 实现 convert.ts**

```ts
// src/lib/roam-import/convert.ts
import { createTree, addNode, newId, type OutlineNode } from '../outline/model'
import { serializeOutline } from '../outline/markdown'
import { touchFrontmatter } from '../outline/frontmatter'
import { convertInline, rewriteLinks, escapeReservedProps } from './syntax'
import type { RoamBlock, RoamPage } from './types'

export interface ConvertedPage {
  title: string
  text: string
  /** 页面级增量判定时间:页与全部 block edit-time 的最大值 */
  editTime: number
}

export function maxEditTime(page: RoamPage): number {
  let max = page['edit-time'] ?? 0
  const walk = (bs: RoamBlock[] | undefined) => {
    for (const b of bs ?? []) {
      if ((b['edit-time'] ?? 0) > max) max = b['edit-time']!
      walk(b.children)
    }
  }
  walk(page.children)
  return max
}

function iso(ms: number | undefined): string | undefined {
  return ms != null ? new Date(ms).toISOString() : undefined
}

function blockContent(b: RoamBlock, renames: Map<string, string>): string {
  let s = escapeReservedProps(rewriteLinks(convertInline(b.string ?? ''), renames))
  if (b.heading != null && b.heading >= 1 && b.heading <= 3) s = `${'#'.repeat(b.heading)} ${s}`
  return s
}

/** RoamPage → 完整 .note.md 文本。refUids 决定哪些节点写 id::,renames 驱动全图重链。 */
export function convertPage(page: RoamPage, refUids: Set<string>, renames: Map<string, string>): ConvertedPage {
  const tree = createTree()
  tree.frontmatter = touchFrontmatter(null, {
    title: page.title,
    created: iso(page['create-time']),
    now: iso(page['edit-time']) ?? new Date().toISOString(),
  })
  const walk = (bs: RoamBlock[] | undefined, parentId: string | null) => {
    ;(bs ?? []).forEach((b, idx) => {
      const node: OutlineNode = {
        id: b.uid ?? newId(),
        parentId,
        order: idx * 100,
        content: blockContent(b, renames),
        collapsed: false,
        source: 'manual',
        persistId: b.uid != null && refUids.has(b.uid) ? true : undefined,
        createdAt: iso(b['create-time']),
        updatedAt: iso(b['edit-time']),
      }
      addNode(tree, node)
      walk(b.children, node.id)
    })
  }
  walk(page.children, null)
  if (tree.nodes.size === 0) {
    addNode(tree, { id: newId(), parentId: null, order: 0, content: '', collapsed: false, source: 'manual' })
  }
  return { title: page.title, text: serializeOutline(tree), editTime: maxEditTime(page) }
}
```

- [ ] **Step 3.4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/roam-import/convert.test.ts`
Expected: PASS。若 `created::` 断言的 ISO 字符串与实现不符,以 `new Date(1600000002000).toISOString()` 实算值修正测试。

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/roam-import/convert.ts src/lib/roam-import/convert.test.ts
git commit -m "feat(roam-import): convert Roam pages to outline note files"
```

---

### Task 4: plan — 文件分配、碰撞改名、增量动作

**Files:**
- Create: `src/lib/roam-import/plan.ts`
- Test: `src/lib/roam-import/plan.test.ts`

依赖既有 API:`sanitizeFileName`(`../outline/slug`)、`dailyDateFromUid`(`./parse`)。

- [ ] **Step 4.1: 写失败测试**

```ts
// src/lib/roam-import/plan.test.ts
import { describe, it, expect } from 'vitest'
import { assignFiles, planActions } from './plan'
import type { ImportManifest, RoamPage } from './types'

const dirs = { wikipage: 'wikipage', dailynote: 'dailynote' }

describe('assignFiles', () => {
  it('routes daily pages by uid and wiki pages by sanitized title', () => {
    const pages: RoamPage[] = [
      { title: 'July 11th, 2026', uid: '07-11-2026' },
      { title: 'a/b', uid: 'p1' },
    ]
    const r = assignFiles(pages, dirs)
    expect(r.files[0]).toMatchObject({ kind: 'daily', relPath: 'dailynote/2026/2026-07-11.note.md' })
    expect(r.files[1]).toMatchObject({ kind: 'wiki', relPath: 'wikipage/a-b.note.md', finalName: 'a-b' })
    expect(r.renames.get('a/b')).toBe('a-b')
  })

  it('dedupes case-insensitive collisions with " (2)" and records renames', () => {
    const pages: RoamPage[] = [
      { title: 'Test', uid: 'p1' },
      { title: 'test', uid: 'p2' },
    ]
    const r = assignFiles(pages, dirs)
    expect(r.files[0].relPath).toBe('wikipage/Test.note.md')
    expect(r.files[1].relPath).toBe('wikipage/test (2).note.md')
    expect(r.renames.get('test')).toBe('test (2)')
    expect(r.warnings).toHaveLength(1)
  })
})

describe('planActions', () => {
  const manifest: ImportManifest = {
    graphName: 'g', importedAt: 'x',
    pages: { p1: { file: 'wikipage/A.note.md', editTime: 100, contentHash: 'h1' } },
  }
  it('create when new, skip when edit-time unchanged', () => {
    const acts = planActions(
      [{ key: 'p2', relPath: 'wikipage/B.note.md', editTime: 5 },
       { key: 'p1', relPath: 'wikipage/A.note.md', editTime: 100 }],
      manifest, new Map([['wikipage/A.note.md', 'h1']]),
    )
    expect(acts).toEqual([
      { key: 'p2', relPath: 'wikipage/B.note.md', action: 'create' },
      { key: 'p1', relPath: 'wikipage/A.note.md', action: 'skip' },
    ])
  })
  it('overwrite when changed and local untouched; conflict when local modified', () => {
    const entries = [{ key: 'p1', relPath: 'wikipage/A.note.md', editTime: 200 }]
    expect(planActions(entries, manifest, new Map([['wikipage/A.note.md', 'h1']]))[0].action).toBe('overwrite')
    expect(planActions(entries, manifest, new Map([['wikipage/A.note.md', 'DIFFERENT']]))[0].action).toBe('conflict')
    expect(planActions(entries, manifest, new Map([['wikipage/A.note.md', null]]))[0].action).toBe('create')
  })
  it('no manifest → everything is create', () => {
    expect(planActions([{ key: 'k', relPath: 'f', editTime: 1 }], null, new Map())[0].action).toBe('create')
  })
})
```

- [ ] **Step 4.2: 跑测试确认失败**

Run: `pnpm vitest run src/lib/roam-import/plan.test.ts`
Expected: FAIL。

- [ ] **Step 4.3: 实现 plan.ts**

```ts
// src/lib/roam-import/plan.ts
import { sanitizeFileName } from '../outline/slug'
import { dailyDateFromUid } from './parse'
import type { ImportManifest, RoamPage } from './types'

export interface PageFile {
  page: RoamPage
  kind: 'daily' | 'wiki'
  /** vault 相对路径 */
  relPath: string
  /** wiki 页最终文件名(= wikilink 目标);daily 页为日期串 */
  finalName: string
}

export interface AssignResult {
  files: PageFile[]
  /** 原标题 → 最终名(仅收录发生变化的),驱动全图 [[链接]] 重写 */
  renames: Map<string, string>
  warnings: string[]
}

/** 页面 → 文件路径。碰撞检测大小写不敏感(macOS 文件系统),后缀 " (2)" 起。 */
export function assignFiles(pages: RoamPage[], dirs: { wikipage: string; dailynote: string }): AssignResult {
  const files: PageFile[] = []
  const renames = new Map<string, string>()
  const warnings: string[] = []
  const taken = new Set<string>()
  for (const page of pages) {
    const daily = dailyDateFromUid(page.uid)
    if (daily) {
      files.push({ page, kind: 'daily', relPath: `${dirs.dailynote}/${daily.slice(0, 4)}/${daily}.note.md`, finalName: daily })
      continue
    }
    const base = sanitizeFileName(page.title)
    let name = base
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`
    taken.add(name.toLowerCase())
    if (name !== base) warnings.push(`title collision: "${page.title}" → "${name}"`)
    if (name !== page.title) renames.set(page.title, name)
    files.push({ page, kind: 'wiki', relPath: `${dirs.wikipage}/${name}.note.md`, finalName: name })
  }
  return { files, renames, warnings }
}

export type ImportAction = 'create' | 'overwrite' | 'skip' | 'conflict'
export interface PlannedPage { key: string; relPath: string; action: ImportAction }

/**
 * 增量动作判定(spec §增量重导):
 * 清单无记录或本地文件不存在 → create;edit-time 未变 → skip;
 * 变了且本地 hash 与清单一致 → overwrite;本地被改过 → conflict。
 * localHashes: relPath → 现文件 sha256(不存在为 null/缺省)。
 */
export function planActions(
  entries: Array<{ key: string; relPath: string; editTime: number }>,
  manifest: ImportManifest | null,
  localHashes: Map<string, string | null>,
): PlannedPage[] {
  return entries.map(({ key, relPath, editTime }) => {
    const prev = manifest?.pages[key]
    const local = localHashes.get(relPath) ?? null
    if (!prev || local == null) return { key, relPath, action: 'create' as const }
    if (prev.editTime === editTime) return { key, relPath, action: 'skip' as const }
    if (local === prev.contentHash) return { key, relPath, action: 'overwrite' as const }
    return { key, relPath, action: 'conflict' as const }
  })
}
```

- [ ] **Step 4.4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/roam-import/plan.test.ts`
Expected: PASS。

- [ ] **Step 4.5: Commit**

```bash
git add src/lib/roam-import/plan.ts src/lib/roam-import/plan.test.ts
git commit -m "feat(roam-import): file assignment, collision renames and incremental plan"
```

---

### Task 5: io — zip 解包、写盘、清单(薄层,不做单测)

**Files:**
- Create: `src/lib/roam-import/io.ts`

- [ ] **Step 5.1: 实现 io.ts**(IO 薄层,vitest 不覆盖,仓库惯例)

```ts
// src/lib/roam-import/io.ts
import { unzipSync, strFromU8 } from 'fflate'
import { joinPath } from '../fs'
import { sha256Hex } from '../hash'
import type { ImportManifest } from './types'

/** 读入用户选的 zip/.json,返回 Roam JSON 文本。zip 内取第一个 .json 条目。 */
export async function readRoamExport(path: string): Promise<string> {
  const { readFile } = await import('@tauri-apps/plugin-fs')
  const bytes = await readFile(path)
  if (path.toLowerCase().endsWith('.json')) return new TextDecoder().decode(bytes)
  const entries = unzipSync(bytes)
  const jsonName = Object.keys(entries).find((n) => n.toLowerCase().endsWith('.json') && !n.startsWith('__MACOSX'))
  if (!jsonName) throw new Error('no .json entry found in zip')
  return strFromU8(entries[jsonName])
}

export async function writeNoteFile(vaultRoot: string, relPath: string, text: string): Promise<void> {
  const abs = joinPath(vaultRoot, relPath)
  const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs')
  await mkdir(abs.slice(0, abs.lastIndexOf('/')), { recursive: true }).catch(() => {})
  await writeTextFile(abs, text)
}

/** 现有文件 sha256;不存在返回 null */
export async function localFileHash(vaultRoot: string, relPath: string): Promise<string | null> {
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  const abs = joinPath(vaultRoot, relPath)
  if (!(await exists(abs).catch(() => false))) return null
  return sha256Hex(await readTextFile(abs))
}

const MANIFEST_REL = '.notemd/roam-import.json'

export async function loadImportManifest(vaultRoot: string): Promise<ImportManifest | null> {
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  const abs = joinPath(vaultRoot, MANIFEST_REL)
  if (!(await exists(abs).catch(() => false))) return null
  try { return JSON.parse(await readTextFile(abs)) as ImportManifest } catch { return null }
}

export async function saveImportManifest(vaultRoot: string, m: ImportManifest): Promise<void> {
  await writeNoteFile(vaultRoot, MANIFEST_REL, JSON.stringify(m, null, 2))
}
```

注意:`joinPath` 来自 `src/lib/fs.ts`,实现前先确认其签名(`grep -n "export function joinPath" src/lib/fs.ts`),不一致就按实际调整。

- [ ] **Step 5.2: 类型检查**

Run: `pnpm check`
Expected: 0 errors。

- [ ] **Step 5.3: Commit**

```bash
git add src/lib/roam-import/io.ts
git commit -m "feat(roam-import): zip/manifest/file IO layer"
```

---

### Task 6: i18n 键(en/zh/ja)

**Files:**
- Modify: `src/lib/i18n/en.ts`(追加键)
- Modify: `src/lib/i18n/zh.ts`(zh 是完整 Record,漏键编译报错)
- Modify: `src/lib/i18n/ja.ts`

- [ ] **Step 6.1: en.ts 追加**(加在文件靠后、其它功能块之间,保持分组注释风格)

```ts
  // Roam import window
  'roamImport.title': 'Import from Roam Research',
  'roamImport.pickFile': 'Choose Roam export (.zip / .json)…',
  'roamImport.noVault': 'Configure a Vault first (Settings → Vault) to import.',
  'roamImport.stage.parse': 'Parsing export…',
  'roamImport.stage.plan': 'Planning import…',
  'roamImport.stage.write': 'Writing notes…',
  'roamImport.progress': '{done} / {total} pages — {current}',
  'roamImport.errors': 'Errors & warnings',
  'roamImport.copyLog': 'Copy log',
  'roamImport.done': 'Import finished: {wiki} wiki pages, {daily} daily notes, {skipped} skipped.',
  'roamImport.doneErrors': 'Finished with {errors} problem(s) — see log below.',
  'roamImport.conflicts': '{count} page(s) modified locally were skipped.',
  'roamImport.overwriteSelected': 'Overwrite selected',
  'roamImport.errParse': 'Export not readable: {error}',
  'roamImport.errWrite': 'Write failed for {page}: {error}',
  'roamImport.warnRenamed': 'Renamed "{from}" → "{to}" (filename constraint)',
```

- [ ] **Step 6.2: zh.ts / ja.ts 补全同名键**

zh:

```ts
  // Roam 导入窗口
  'roamImport.title': '从 Roam Research 导入',
  'roamImport.pickFile': '选择 Roam 导出文件(.zip / .json)…',
  'roamImport.noVault': '请先在 设置 → Vault 配置仓库后再导入。',
  'roamImport.stage.parse': '正在解析导出文件…',
  'roamImport.stage.plan': '正在计算导入计划…',
  'roamImport.stage.write': '正在写入笔记…',
  'roamImport.progress': '{done} / {total} 页 — {current}',
  'roamImport.errors': '错误与警告',
  'roamImport.copyLog': '复制日志',
  'roamImport.done': '导入完成:{wiki} 个 wiki 页、{daily} 篇日记、跳过 {skipped}。',
  'roamImport.doneErrors': '完成,但有 {errors} 个问题——见下方日志。',
  'roamImport.conflicts': '{count} 个页面因本地已修改被跳过。',
  'roamImport.overwriteSelected': '覆盖所选',
  'roamImport.errParse': '导出文件不可读:{error}',
  'roamImport.errWrite': '写入 {page} 失败:{error}',
  'roamImport.warnRenamed': '"{from}" 改名为 "{to}"(文件名约束)',
```

ja:

```ts
  // Roam インポートウィンドウ
  'roamImport.title': 'Roam Research からインポート',
  'roamImport.pickFile': 'Roam エクスポートを選択(.zip / .json)…',
  'roamImport.noVault': '先に 設定 → Vault でボールトを設定してください。',
  'roamImport.stage.parse': 'エクスポートを解析中…',
  'roamImport.stage.plan': 'インポート計画を作成中…',
  'roamImport.stage.write': 'ノートを書き込み中…',
  'roamImport.progress': '{done} / {total} ページ — {current}',
  'roamImport.errors': 'エラーと警告',
  'roamImport.copyLog': 'ログをコピー',
  'roamImport.done': '完了:wiki {wiki} 件、デイリー {daily} 件、スキップ {skipped} 件。',
  'roamImport.doneErrors': '完了しましたが {errors} 件の問題があります(下のログ参照)。',
  'roamImport.conflicts': 'ローカルで変更済みの {count} ページをスキップしました。',
  'roamImport.overwriteSelected': '選択を上書き',
  'roamImport.errParse': 'エクスポートを読み込めません:{error}',
  'roamImport.errWrite': '{page} の書き込みに失敗:{error}',
  'roamImport.warnRenamed': '「{from}」を「{to}」に改名(ファイル名制約)',
```

- [ ] **Step 6.3: 验证 + Commit**

Run: `pnpm check`
Expected: 0 errors(zh/ja 若漏键这里会报)。

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts
git commit -m "feat(roam-import): i18n strings for import window"
```

---

### Task 7: 独立导入窗口(html + 入口 + Svelte 应用)+ vite 多入口

**Files:**
- Create: `roam-import.html`
- Create: `src/roam-import-main.ts`
- Create: `src/roam-import-app.svelte`
- Modify: `vite.config.ts`(input/entries 各加一行)

- [ ] **Step 7.1: roam-import.html**(仿 insights.html)

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Import from Roam Research</title>
  </head>
  <body>
    <div id="roam-import-app"></div>
    <script type="module" src="/src/roam-import-main.ts"></script>
  </body>
</html>
```

- [ ] **Step 7.2: src/roam-import-main.ts**

```ts
import { mount } from 'svelte'
import RoamImportApp from './roam-import-app.svelte'

const target = document.getElementById('roam-import-app')
if (!target) throw new Error('roam-import-app root missing')
mount(RoamImportApp, { target })
```

- [ ] **Step 7.3: vite.config.ts 两处各加一行**

```ts
        roamImport: 'roam-import.html',   // rollupOptions.input 内
```

```ts
    entries: ['index.html', 'chat.html', 'insights.html', 'roam-import.html'],
```

- [ ] **Step 7.4: src/roam-import-app.svelte**(核心界面:文件选择 → 三阶段进度 → 醒目错误日志 → 摘要 + 冲突覆盖)

```svelte
<script lang="ts">
  import { loadLocale, t } from './lib/i18n/store.svelte'
  import { refreshSotvault, sotvaultStore } from './lib/sotvault.svelte'
  import { loadOutlineDirs, outlineDirs } from './lib/outline/dirs.svelte'
  import { sha256Hex } from './lib/hash'
  import { parseRoamJson } from './lib/roam-import/parse'
  import { assignFiles, planActions, type PlannedPage } from './lib/roam-import/plan'
  import { convertPage, type ConvertedPage } from './lib/roam-import/convert'
  import { pageKey, type ImportManifest } from './lib/roam-import/types'
  import { readRoamExport, writeNoteFile, localFileHash, loadImportManifest, saveImportManifest } from './lib/roam-import/io'

  type LogEntry = { level: 'error' | 'warn'; page: string; message: string }
  type Stage = 'idle' | 'parse' | 'plan' | 'write' | 'done'

  let ready = $state(false)
  let stage = $state<Stage>('idle')
  let total = $state(0)
  let done = $state(0)
  let current = $state('')
  let log = $state<LogEntry[]>([])
  let summary = $state<{ wiki: number; daily: number; skipped: number } | null>(null)
  let conflicts = $state<Array<{ key: string; relPath: string; selected: boolean }>>([])
  /** 冲突覆盖重试所需的转换缓存 */
  let convertedByKey: Map<string, { relPath: string; page: ConvertedPage }> = new Map()
  let manifestDraft: ImportManifest | null = null

  $effect(() => {
    void (async () => {
      await loadLocale()
      await refreshSotvault()
      await loadOutlineDirs()
      ready = true
    })()
  })

  const yieldUi = () => new Promise((r) => setTimeout(r))

  async function pickAndImport() {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const picked = await open({ multiple: false, filters: [{ name: 'Roam export', extensions: ['zip', 'json'] }] })
    if (typeof picked !== 'string') return
    log = []; summary = null; conflicts = []; done = 0; total = 0; current = ''
    convertedByKey = new Map()
    const vault = sotvaultStore.vaultRoot
    if (!vault) return
    try {
      stage = 'parse'
      await yieldUi()
      const graph = parseRoamJson(await readRoamExport(picked))

      stage = 'plan'
      await yieldUi()
      const assigned = assignFiles(graph.pages, { wikipage: outlineDirs.wikipage, dailynote: outlineDirs.dailynote })
      for (const w of assigned.warnings) log = [...log, { level: 'warn', page: '', message: w }]
      const prevManifest = await loadImportManifest(vault)
      const entries: Array<{ key: string; relPath: string; editTime: number }> = []
      for (const f of assigned.files) {
        try {
          const conv = convertPage(f.page, graph.referencedUids, assigned.renames)
          const key = pageKey(f.page)
          convertedByKey.set(key, { relPath: f.relPath, page: conv })
          entries.push({ key, relPath: f.relPath, editTime: conv.editTime })
        } catch (e) {
          log = [...log, { level: 'error', page: f.page.title, message: String(e) }]
        }
      }
      const hashes = new Map<string, string | null>()
      for (const en of entries) hashes.set(en.relPath, await localFileHash(vault, en.relPath))
      const actions = planActions(entries, prevManifest, hashes)

      stage = 'write'
      total = actions.length
      manifestDraft = {
        graphName: picked.split('/').pop() ?? 'roam',
        importedAt: new Date().toISOString(),
        pages: { ...(prevManifest?.pages ?? {}) },
      }
      let wiki = 0, daily = 0, skipped = 0
      for (const a of actions) {
        const conv = convertedByKey.get(a.key)!
        current = conv.page.title
        if (a.action === 'skip') { skipped++ }
        else if (a.action === 'conflict') {
          conflicts = [...conflicts, { key: a.key, relPath: a.relPath, selected: false }]
          log = [...log, { level: 'warn', page: conv.page.title, message: t('roamImport.conflicts', { count: 1 }) }]
        } else {
          await writePage(vault, a, conv.page)
          if (a.relPath.startsWith(outlineDirs.dailynote)) daily++; else wiki++
        }
        done++
        if (done % 20 === 0) await yieldUi()
      }
      await saveImportManifest(vault, manifestDraft)
      summary = { wiki, daily, skipped }
      stage = 'done'
    } catch (e) {
      log = [...log, { level: 'error', page: '', message: t('roamImport.errParse', { error: String(e) }) }]
      stage = 'done'
    }
  }

  async function writePage(vault: string, a: PlannedPage, conv: ConvertedPage) {
    try {
      await writeNoteFile(vault, a.relPath, conv.text)
      manifestDraft!.pages[a.key] = { file: a.relPath, editTime: conv.editTime, contentHash: await sha256Hex(conv.text) }
    } catch (e) {
      log = [...log, { level: 'error', page: conv.page?.title ?? a.relPath, message: t('roamImport.errWrite', { page: a.relPath, error: String(e) }) }]
    }
  }

  async function overwriteSelected() {
    const vault = sotvaultStore.vaultRoot
    if (!vault || !manifestDraft) return
    for (const c of conflicts.filter((c) => c.selected)) {
      const conv = convertedByKey.get(c.key)
      if (conv) await writePage(vault, { key: c.key, relPath: c.relPath, action: 'overwrite' }, conv.page)
    }
    conflicts = conflicts.filter((c) => !c.selected)
    await saveImportManifest(vault, manifestDraft)
  }

  async function copyLog() {
    const text = log.map((l) => `[${l.level}] ${l.page ? l.page + ': ' : ''}${l.message}`).join('\n')
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    await writeText(text)
  }
</script>

{#if ready}
  <main>
    <h1>{t('roamImport.title')}</h1>
    {#if sotvaultStore.vaultRoot === null}
      <p class="no-vault">{t('roamImport.noVault')}</p>
    {:else}
      <button class="pick" onclick={pickAndImport} disabled={stage === 'parse' || stage === 'plan' || stage === 'write'}>
        {t('roamImport.pickFile')}
      </button>

      {#if stage !== 'idle'}
        <section class="progress">
          {#if stage === 'parse'}<p>{t('roamImport.stage.parse')}</p>{/if}
          {#if stage === 'plan'}<p>{t('roamImport.stage.plan')}</p>{/if}
          {#if stage === 'write' || stage === 'done'}
            <p>{t('roamImport.stage.write')}</p>
            <progress max={total} value={done}></progress>
            <p class="counter">{t('roamImport.progress', { done, total, current })}</p>
          {/if}
        </section>
      {/if}

      {#if summary}
        <section class="summary" class:has-errors={log.some((l) => l.level === 'error')}>
          {#if log.some((l) => l.level === 'error')}
            <p class="banner error-banner">{t('roamImport.doneErrors', { errors: log.filter((l) => l.level === 'error').length })}</p>
          {:else}
            <p class="banner ok-banner">{t('roamImport.done', { wiki: summary.wiki, daily: summary.daily, skipped: summary.skipped })}</p>
          {/if}
        </section>
      {/if}

      {#if conflicts.length > 0}
        <section class="conflicts">
          <p>{t('roamImport.conflicts', { count: conflicts.length })}</p>
          {#each conflicts as c}
            <label><input type="checkbox" bind:checked={c.selected} /> {c.relPath}</label>
          {/each}
          <button onclick={overwriteSelected} disabled={!conflicts.some((c) => c.selected)}>
            {t('roamImport.overwriteSelected')}
          </button>
        </section>
      {/if}

      {#if log.length > 0}
        <section class="error-log">
          <header>
            <h2>{t('roamImport.errors')}</h2>
            <button onclick={copyLog}>{t('roamImport.copyLog')}</button>
          </header>
          <ul>
            {#each log as l}
              <li class={l.level}>{l.page ? `${l.page}: ` : ''}{l.message}</li>
            {/each}
          </ul>
        </section>
      {/if}
    {/if}
  </main>
{/if}

<style>
  :global(:root) { color-scheme: light dark; }
  main { font-family: -apple-system, sans-serif; padding: 16px 20px; max-width: 640px; margin: 0 auto; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  .pick { font-size: 14px; padding: 6px 14px; }
  .progress { margin-top: 14px; }
  progress { width: 100%; }
  .counter { font-size: 12px; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .banner { padding: 10px 12px; border-radius: 6px; font-weight: 600; }
  .ok-banner { background: color-mix(in srgb, #34c759 18%, transparent); }
  .error-banner { background: color-mix(in srgb, #ff3b30 22%, transparent); }
  .conflicts { margin-top: 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, #ff9500 55%, transparent); border-radius: 6px; }
  .conflicts label { display: block; font-size: 12px; padding: 2px 0; }
  .error-log { margin-top: 14px; border: 1px solid color-mix(in srgb, #ff3b30 55%, transparent); border-radius: 6px; }
  .error-log header { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px;
    background: color-mix(in srgb, #ff3b30 14%, transparent); }
  .error-log h2 { font-size: 13px; margin: 0; }
  .error-log ul { list-style: none; margin: 0; padding: 6px 10px; max-height: 220px; overflow: auto; font-size: 12px; font-family: ui-monospace, monospace; }
  .error-log li.error { color: #ff3b30; }
  .error-log li.warn { color: #ff9500; }
</style>
```

注意:剪贴板插件包名先确认(`grep clipboard package.json`);若无 clipboard-manager 插件,改用 `navigator.clipboard.writeText`。

- [ ] **Step 7.5: 验证**

Run: `pnpm check && pnpm build`
Expected: 0 errors;`dist/` 出现 roam-import 入口产物。

- [ ] **Step 7.6: Commit**

```bash
git add roam-import.html src/roam-import-main.ts src/roam-import-app.svelte vite.config.ts
git commit -m "feat(roam-import): standalone import window with progress and error log"
```

---

### Task 8: 插件门面(manifest + Rust 窗口命令 + App.svelte 分发)

**Files:**
- Create: `src-tauri/plugins/roam-import/manifest.json`
- Modify: `src-tauri/src/lib.rs`(加 `show_roam_import_window` + 注册)
- Modify: `src/App.svelte`(`dispatchPlugin` 加分支,~line 342 之前)

- [ ] **Step 8.1: manifest.json**(仿 outline-notes,builtin、默认关)

```json
{
  "id": "roam-import",
  "name": "Roam Research Import",
  "version": "0.1.0",
  "description": "Import a Roam Research JSON export into your vault as daily notes and wiki pages, with incremental re-import.",
  "kind": "builtin",
  "default_enabled": false,
  "host_capabilities": [],
  "menus": [
    {
      "location": "file",
      "label": "Import from Roam Research…",
      "command": "open"
    }
  ],
  "i18n": {
    "zh": {
      "name": "Roam Research 导入",
      "description": "把 Roam Research 的 JSON 导出转换为 vault 里的日记与 wiki 页,支持增量重导。",
      "menus": { "open": "从 Roam Research 导入…" }
    },
    "ja": {
      "name": "Roam Research インポート",
      "description": "Roam Research の JSON エクスポートをデイリーノートと wiki ページとして取り込みます(増分再インポート対応)。",
      "menus": { "open": "Roam Research からインポート…" }
    }
  }
}
```

- [ ] **Step 8.2: lib.rs 加窗口命令**(仿 `show_insights_window`,不加 cfg;放它旁边)

```rust
#[tauri::command]
fn show_roam_import_window(app: tauri::AppHandle) {
    use tauri::WebviewUrl;
    if !plugin_host::is_plugin_enabled("roam-import") { return; }
    let win = app.get_webview_window("roam-import").or_else(|| {
        tauri::WebviewWindowBuilder::new(&app, "roam-import", WebviewUrl::App("roam-import.html".into()))
            .title("Import from Roam Research")
            .inner_size(680.0, 620.0)
            .min_inner_size(520.0, 420.0)
            .resizable(true)
            .decorations(true)
            .visible(false)
            .build()
            .map_err(|e| eprintln!("[roam-import] window build failed: {e}"))
            .ok()
    });
    if let Some(w) = win {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
```

并在 `tauri::generate_handler![...]` 列表(含 `invoke_plugin` 的那份;若 ios/desktop 两份都含则两份都加)加入 `show_roam_import_window,`。`plugin_host::is_plugin_enabled` 已存在(plugin_host.rs)。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 通过。若 ios 目标那份 handler 编译不过,把命令函数保持无 cfg、检查 `get_webview_window` 可用性,或仅注册进 desktop 那份。

- [ ] **Step 8.3: App.svelte dispatchPlugin 加分支**(在 `const m = manifestById[pluginId]` 之前,与 outline-notes 分支并列)

```ts
        if (pluginId === 'roam-import') {
          if (command === 'open') await invoke('show_roam_import_window')
          return
        }
```

- [ ] **Step 8.4: 验证 + Commit**

Run: `pnpm check && pnpm test && cargo check --manifest-path src-tauri/Cargo.toml`
Expected: 全绿。

```bash
git add src-tauri/plugins/roam-import/manifest.json src-tauri/src/lib.rs src/App.svelte
git commit -m "feat(roam-import): builtin plugin manifest, window command and menu dispatch"
```

---

### Task 9: 端到端 fixture 测试(转换全链路纯函数部分)

**Files:**
- Create: `src/lib/roam-import/fixture.test.ts`

- [ ] **Step 9.1: 写覆盖 spec 测试清单的 fixture 测试**(日记页/深嵌套/跨页块引用/embed/TODO/属性撞名/标题碰撞/多行代码块)

```ts
// src/lib/roam-import/fixture.test.ts
import { describe, it, expect } from 'vitest'
import { parseRoamJson } from './parse'
import { assignFiles } from './plan'
import { convertPage } from './convert'
import { parseOutline } from '../outline/markdown'

const FIXTURE = JSON.stringify([
  { title: 'July 11th, 2026', uid: '07-11-2026', 'edit-time': 1,
    children: [
      { uid: 'day1', string: 'ref to ((tgt1)) and {{[[embed]]: ((tgt2))}}' },
      { uid: 'day2', string: '{{[[TODO]]}} task with [[Case Page]]' },
    ] },
  { title: 'Case Page', uid: 'w1', children: [
    { uid: 'tgt1', string: 'deep', children: [
      { uid: 'tgt2', string: 'deeper', children: [
        { uid: 'x1', string: 'code:\n```js\n__keep__\n```' },
        { uid: 'x2', string: 'line1\nid:: sneaky' },
      ] },
    ] },
  ] },
  { title: 'case page', uid: 'w2', children: [{ uid: 'y1', string: 'collides' }] },
])

describe('roam-import end-to-end (pure)', () => {
  const graph = parseRoamJson(FIXTURE)
  const assigned = assignFiles(graph.pages, { wikipage: 'wikipage', dailynote: 'dailynote' })

  it('routes daily + wiki files, dedupes collision', () => {
    expect(assigned.files.map((f) => f.relPath)).toEqual([
      'dailynote/2026/2026-07-11.note.md',
      'wikipage/Case Page.note.md',
      'wikipage/case page (2).note.md',
    ])
  })

  it('converted output round-trips through parseOutline with ids preserved', () => {
    const casePage = assigned.files[1]
    const out = convertPage(casePage.page, graph.referencedUids, assigned.renames)
    const tree = parseOutline(out.text)
    const ids = [...tree.nodes.keys()]
    expect(ids).toContain('tgt1')   // 被引用 → id:: 落盘并被解析回来
    expect(ids).toContain('tgt2')
    const contents = [...tree.nodes.values()].map((n) => n.content)
    expect(contents.some((c) => c.includes('```js\n__keep__\n```'))).toBe(true) // 代码块原样
    expect(contents.some((c) => c.includes(' id:: sneaky'))).toBe(true)         // 转义存活为内容
  })

  it('daily page links rewrite to the renamed collision target only when renamed', () => {
    const dailyOut = convertPage(assigned.files[0].page, graph.referencedUids, assigned.renames)
    expect(dailyOut.text).toContain('[[Case Page]]') // 未改名的不动
    expect(dailyOut.text).toContain('((tgt1))')
    expect(dailyOut.text).toContain('((tgt2))')      // embed 已降级
    expect(dailyOut.text).toContain('[ ] task')
  })
})
```

- [ ] **Step 9.2: 跑测试**

Run: `pnpm vitest run src/lib/roam-import/fixture.test.ts`
Expected: PASS(失败则修实现,不改弱断言)。

- [ ] **Step 9.3: 全量回归 + Commit**

Run: `pnpm check && pnpm test`
Expected: 全绿。

```bash
git add src/lib/roam-import/fixture.test.ts
git commit -m "test(roam-import): end-to-end fixture covering spec checklist"
```

---

### Task 10: dev GUI 实机验证(手动/脚本,不自动 merge)

**Files:** 无代码改动(发现问题则回上面任务修)。

- [ ] **Step 10.1: 造一份真实结构的测试导出**(用 Task 9 fixture 内容存成 `/tmp/roam-test.json`)

- [ ] **Step 10.2: dev 构建实机验证清单**(参考 memory 的 dev GUI 验证方法;先确认桌面无并发会话)

1. 设置 → 插件:出现 "Roam Research Import",默认关;File 菜单**无**导入项。
2. 开启插件 → File 菜单出现 "从 Roam Research 导入…"(zh locale)。
3. 点击 → 独立窗口打开,深浅色正常(color-scheme)。
4. 选 `/tmp/roam-test.json` → 进度走完,绿色完成横幅,vault 出现 `dailynote/2026/2026-07-11.note.md` + 两个 wikipage 文件,碰撞警告在日志区(橙色)。
5. 手改 `wikipage/Case Page.note.md` 一行,再导入同文件 → 全部 skip(edit-time 未变);把 fixture 里 edit-time 改大再导 → 该页出现冲突条目,勾选覆盖生效。
6. 选一个坏 zip → 红色错误横幅 + 日志区醒目报错,vault 无写入。
7. 关闭插件 → File 菜单项消失。

- [ ] **Step 10.3: 验证结论记录**

把验证结果(截图路径/问题清单)写进 PR 描述或会话总结;未过项回修后重验。

---

## Self-Review 结论(写计划时已做)

- spec 覆盖:格式选择(Task1 parse)、页面归类命名(Task4)、语法映射(Task2/3)、增量清单与冲突(Task4/5/7)、插件门面(Task8)、独立窗口三区 UI(Task7)、i18n(Task6+manifest)、错误处理(Task7 try/catch 分层)、测试(Task1-4、9)、GUI 验证(Task10)——全部有对应任务。
- 类型一致性:`ConvertedPage.title/text/editTime`、`PlannedPage.key/relPath/action`、`pageKey` 贯穿 Task3/4/7 一致。
- 两处运行时需现场确认的既有 API 已在步骤中标注(joinPath 签名、clipboard 插件名),不算 placeholder:给了确认命令与回退方案。
