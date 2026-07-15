# Base 插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 mdeditor 能打开 Obsidian 兼容的 `.base` 文件,把其所在目录(递归)的 md 元数据渲染成只读结构化表格。

**Architecture:** 纯逻辑(parse / filter / rows)与文件扫描(scan)是可单测的独立模块;`.base` 作为新 `FileKind` 由 `openFile` 以 rich 模式打开,`EditorPane` 分派到薄壳组件 `BaseView.svelte`,它编排 scan+parse+rows 并渲染自写 HTML 表格。source 模式与插件关闭时回退成原始 YAML 文本。

**Tech Stack:** TypeScript, Svelte 5 (runes), Vitest, `yaml` 包, Tauri fs 插件。

参照设计:`docs/superpowers/specs/2026-07-14-base-plugin-design.md`

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/lib/fs.ts` | 新增 `base` FileKind + 扩展名映射 | 改 |
| `src/lib/base/model.ts` | 类型定义 | 建 |
| `src/lib/base/parse.ts` | YAML → `BaseConfig`,容错 | 建 |
| `src/lib/base/parse.test.ts` | parse 单测 | 建 |
| `src/lib/base/filter.ts` | filter DSL 求值器 | 建 |
| `src/lib/base/filter.test.ts` | filter 单测 | 建 |
| `src/lib/base/rows.ts` | 属性解析 + 排序 + 分组 | 建 |
| `src/lib/base/rows.test.ts` | rows 单测 | 建 |
| `src/lib/base/scan.ts` | 递归扫描目录、解析 frontmatter(依赖注入,可单测) | 建 |
| `src/lib/base/scan.test.ts` | scan 单测(假 fs) | 建 |
| `src/lib/tabs.svelte.ts` | `openFile` 对 `.base` 强制 rich | 改 |
| `src/components/BaseView.svelte` | 表格 UI 薄壳 | 建 |
| `src/components/EditorPane.svelte` | 分派 base kind | 改 |
| `src/lib/i18n/{en,zh,ja,de}.ts` | `base.*` 文案 | 改 |

---

## Task 1: fs.ts 识别 `.base`

**Files:**
- Modify: `src/lib/fs.ts`(`FileKind` 类型定义处 + `EXT_TABLE`)
- Test: `src/lib/fs.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/fs.test.ts` 末尾(`describe` 内,与现有 classify 测试同级)加:

```ts
it('classifies .base files as base kind', () => {
  expect(classifyPath('/vault/tasks.base')).toEqual({ kind: 'base' })
})
```

若文件顶部尚未导入 `classifyPath`,确认其在现有 import 中(多数 classify 测试已导入)。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/lib/fs.test.ts -t "base kind"`
Expected: FAIL,`classifyPath` 返回 `null`(`.base` 未映射)。

- [ ] **Step 3: 最小实现**

在 `src/lib/fs.ts` 的 `FileKind` 联合类型加 `'base'`:

```ts
export type FileKind = 'markdown' | 'html' | 'code' | 'image' | 'spreadsheet' | 'base'
```

在 `EXT_TABLE` 内(紧挨 `csv:` 附近)加一行:

```ts
  base:      { kind: 'base' },
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/lib/fs.test.ts -t "base kind"`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/fs.ts src/lib/fs.test.ts
git commit -m "feat(base): classify .base files as new base FileKind

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: base/model.ts 类型定义

**Files:**
- Create: `src/lib/base/model.ts`

无独立测试(纯类型),由后续任务消费。

- [ ] **Step 1: 写类型文件**

创建 `src/lib/base/model.ts`:

```ts
/** Obsidian-compatible .base data model (v1 subset). */

export type SortDirection = 'ASC' | 'DESC'

export interface BaseSort {
  property: string
  direction: SortDirection
}

/** A filter node: structured and/or/not, or a leaf statement string. */
export type BaseFilter =
  | { and: BaseFilter[] }
  | { or: BaseFilter[] }
  | { not: BaseFilter[] }
  | string

export interface BaseView {
  type: string // v1 只渲染 'table'
  name: string
  order?: string[]
  groupBy?: BaseSort
  filters?: BaseFilter
  limit?: number
}

export interface BaseConfig {
  filters?: BaseFilter
  properties: Record<string, { displayName?: string }>
  views: BaseView[]
  /** 非空表示解析失败,原始 YAML 无法结构化。 */
  error?: string
  /** 原始解析对象(未来写回/保留未支持字段用)。 */
  raw?: unknown
}

/** One markdown file's scanned metadata. */
export interface FileRecord {
  path: string
  name: string // 含扩展名
  folder: string // 父目录
  ext: string // 不含点
  mtime: number // ms
  ctime: number // ms
  size: number // bytes
  tags: string[] // v1:仅 frontmatter tags
  frontmatter: Record<string, unknown>
}

/** A table row: the source record plus resolved cell values by property id. */
export interface BaseRow {
  record: FileRecord
  cells: Record<string, unknown>
}
```

- [ ] **Step 2: 提交**

```bash
git add src/lib/base/model.ts
git commit -m "feat(base): add BaseConfig/FileRecord/BaseRow data model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: base/parse.ts 解析 .base YAML

**Files:**
- Create: `src/lib/base/parse.ts`
- Test: `src/lib/base/parse.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/base/parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseBase } from './parse'

describe('parseBase', () => {
  it('extracts views with order and groupBy', () => {
    const cfg = parseBase(`
views:
  - type: table
    name: All
    order: [file.name, note.status]
    groupBy:
      property: note.status
      direction: DESC
`)
    expect(cfg.error).toBeUndefined()
    expect(cfg.views).toHaveLength(1)
    expect(cfg.views[0]).toMatchObject({
      type: 'table',
      name: 'All',
      order: ['file.name', 'note.status'],
      groupBy: { property: 'note.status', direction: 'DESC' },
    })
  })

  it('reads global filters and property displayNames', () => {
    const cfg = parseBase(`
filters:
  and:
    - file.hasTag("book")
properties:
  note.status:
    displayName: Status
views:
  - type: table
    name: T
`)
    expect(cfg.filters).toEqual({ and: ['file.hasTag("book")'] })
    expect(cfg.properties['note.status']).toEqual({ displayName: 'Status' })
  })

  it('defaults to one empty table view when views missing', () => {
    const cfg = parseBase('filters:\n  and: []\n')
    expect(cfg.error).toBeUndefined()
    expect(cfg.views).toHaveLength(1)
    expect(cfg.views[0].type).toBe('table')
  })

  it('returns an error for malformed YAML', () => {
    const cfg = parseBase('views: [unclosed')
    expect(cfg.error).toBeTruthy()
    expect(cfg.views).toHaveLength(1) // 仍给一个空表视图,UI 可渲染错误态
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/lib/base/parse.test.ts`
Expected: FAIL,`./parse` 模块不存在。

- [ ] **Step 3: 最小实现**

创建 `src/lib/base/parse.ts`:

```ts
import { parse } from 'yaml'
import type { BaseConfig, BaseView, BaseSort } from './model'

const EMPTY_VIEW: BaseView = { type: 'table', name: 'Table' }

function toSort(v: unknown): BaseSort | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (typeof o.property !== 'string') return undefined
  const dir = o.direction === 'DESC' ? 'DESC' : 'ASC'
  return { property: o.property, direction: dir }
}

function toView(v: unknown): BaseView {
  if (!v || typeof v !== 'object') return { ...EMPTY_VIEW }
  const o = v as Record<string, unknown>
  return {
    type: typeof o.type === 'string' ? o.type : 'table',
    name: typeof o.name === 'string' ? o.name : 'Table',
    order: Array.isArray(o.order) ? o.order.filter((x): x is string => typeof x === 'string') : undefined,
    groupBy: toSort(o.groupBy),
    filters: (o.filters as BaseView['filters']) ?? undefined,
    limit: typeof o.limit === 'number' ? o.limit : undefined,
  }
}

/** Parse .base YAML text into a BaseConfig. Never throws. */
export function parseBase(text: string): BaseConfig {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    return { properties: {}, views: [{ ...EMPTY_VIEW }], error: String(e) }
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const viewsRaw = Array.isArray(o.views) ? o.views : []
  const views = viewsRaw.length ? viewsRaw.map(toView) : [{ ...EMPTY_VIEW }]
  const props = (o.properties && typeof o.properties === 'object' ? o.properties : {}) as BaseConfig['properties']
  return {
    filters: (o.filters as BaseConfig['filters']) ?? undefined,
    properties: props,
    views,
    raw,
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/lib/base/parse.test.ts`
Expected: PASS(4 通过)

- [ ] **Step 5: 提交**

```bash
git add src/lib/base/parse.ts src/lib/base/parse.test.ts
git commit -m "feat(base): parse .base YAML into BaseConfig with fault tolerance

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: base/filter.ts 求值器

**Files:**
- Create: `src/lib/base/filter.ts`
- Test: `src/lib/base/filter.test.ts`

支持子集:`and/or/not` + 叶子(比较表达式 / 函数)。未识别叶子 fail-open(保留该行)。

- [ ] **Step 1: 写失败测试**

创建 `src/lib/base/filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { evalFilter, resolveProp } from './filter'
import type { FileRecord } from './model'

function rec(over: Partial<FileRecord> = {}): FileRecord {
  return {
    path: '/v/books/dune.md', name: 'dune.md', folder: '/v/books',
    ext: 'md', mtime: 100, ctime: 50, size: 20,
    tags: ['book', 'scifi'], frontmatter: { status: 'read', rating: 5 },
    ...over,
  }
}

describe('resolveProp', () => {
  it('resolves file.*, note.field and bare field', () => {
    const r = rec()
    expect(resolveProp('file.name', r)).toBe('dune.md')
    expect(resolveProp('file.ext', r)).toBe('md')
    expect(resolveProp('note.status', r)).toBe('read')
    expect(resolveProp('rating', r)).toBe(5)
    expect(resolveProp('formula.x', r)).toBeUndefined()
  })
})

describe('evalFilter', () => {
  it('undefined filter keeps every row', () => {
    expect(evalFilter(undefined, rec())).toBe(true)
  })

  it('comparison operators', () => {
    expect(evalFilter('rating >= 5', rec())).toBe(true)
    expect(evalFilter('rating > 5', rec())).toBe(false)
    expect(evalFilter('status == "read"', rec())).toBe(true)
    expect(evalFilter('status != "read"', rec())).toBe(false)
  })

  it('file functions', () => {
    expect(evalFilter('file.hasTag("book")', rec())).toBe(true)
    expect(evalFilter('file.hasTag("missing")', rec())).toBe(false)
    expect(evalFilter('file.inFolder("books")', rec())).toBe(true)
    expect(evalFilter('file.inFolder("notes")', rec())).toBe(false)
  })

  it('and / or / not', () => {
    expect(evalFilter({ and: ['rating >= 5', 'file.hasTag("book")'] }, rec())).toBe(true)
    expect(evalFilter({ and: ['rating >= 5', 'file.hasTag("no")'] }, rec())).toBe(false)
    expect(evalFilter({ or: ['rating > 9', 'file.hasTag("scifi")'] }, rec())).toBe(true)
    expect(evalFilter({ not: ['file.hasTag("draft")'] }, rec())).toBe(true)
  })

  it('unknown leaf fails open (keeps row)', () => {
    expect(evalFilter('someWeird.thing(1,2,3)', rec())).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/lib/base/filter.test.ts`
Expected: FAIL,`./filter` 不存在。

- [ ] **Step 3: 最小实现**

创建 `src/lib/base/filter.ts`:

```ts
import type { BaseFilter, FileRecord } from './model'

/** Resolve a property path against a record. `file.*` → file props;
 *  `note.x` / bare `x` → frontmatter; `formula.*` → undefined (v1). */
export function resolveProp(path: string, rec: FileRecord): unknown {
  if (path.startsWith('file.')) {
    const k = path.slice(5)
    switch (k) {
      case 'name': return rec.name
      case 'path': return rec.path
      case 'folder': return rec.folder
      case 'ext': return rec.ext
      case 'mtime': return rec.mtime
      case 'ctime': return rec.ctime
      case 'size': return rec.size
      case 'tags': return rec.tags
      default: return undefined
    }
  }
  if (path.startsWith('formula.')) return undefined
  const key = path.startsWith('note.') ? path.slice(5) : path
  return rec.frontmatter[key]
}

function parseLiteral(s: string): unknown {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  if (t === 'true') return true
  if (t === 'false') return false
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t)
  return t
}

function compare(a: unknown, op: string, b: unknown): boolean {
  if (op === '==') return String(a) === String(b) || a === b
  if (op === '!=') return !(String(a) === String(b) || a === b)
  const na = typeof a === 'number' ? a : Number(a)
  const nb = typeof b === 'number' ? b : Number(b)
  if (Number.isNaN(na) || Number.isNaN(nb)) return false
  if (op === '>') return na > nb
  if (op === '<') return na < nb
  if (op === '>=') return na >= nb
  if (op === '<=') return na <= nb
  return false
}

const FN_RE = /^([\w.]+)\s*\((.*)\)$/
const CMP_RE = /^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/

/** Evaluate a leaf statement. Unknown/unsupported → true (fail-open). */
function evalLeaf(stmt: string, rec: FileRecord): boolean {
  const fn = FN_RE.exec(stmt.trim())
  if (fn) {
    const name = fn[1]
    const arg = parseLiteral(fn[2])
    const argS = String(arg).replace(/^#/, '')
    switch (name) {
      case 'file.hasTag':
        return rec.tags.map((x) => x.replace(/^#/, '')).includes(argS)
      case 'file.inFolder':
        return rec.folder === argS || rec.folder.endsWith('/' + argS) || rec.folder.includes('/' + argS + '/')
      default:
        return true // 未支持函数(含 file.hasLink):fail-open
    }
  }
  const cmp = CMP_RE.exec(stmt.trim())
  if (cmp) {
    const left = resolveProp(cmp[1].trim(), rec)
    const right = parseLiteral(cmp[3])
    return compare(left, cmp[2], right)
  }
  return true // 无法解析:fail-open
}

/** Evaluate a filter tree against a record. */
export function evalFilter(filter: BaseFilter | undefined, rec: FileRecord): boolean {
  if (filter == null) return true
  if (typeof filter === 'string') return evalLeaf(filter, rec)
  if ('and' in filter) return filter.and.every((f) => evalFilter(f, rec))
  if ('or' in filter) return filter.or.some((f) => evalFilter(f, rec))
  if ('not' in filter) return !filter.not.every((f) => evalFilter(f, rec)) // NOT(AND)
  return true
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/lib/base/filter.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/base/filter.ts src/lib/base/filter.test.ts
git commit -m "feat(base): filter DSL evaluator (and/or/not + funcs + comparisons)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: base/rows.ts 建行 + 排序 + 分组

**Files:**
- Create: `src/lib/base/rows.ts`
- Test: `src/lib/base/rows.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/lib/base/rows.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildRows, sortRows, groupRows, displayCell } from './rows'
import type { FileRecord } from './model'

function rec(name: string, fm: Record<string, unknown>, over: Partial<FileRecord> = {}): FileRecord {
  return {
    path: '/v/' + name, name, folder: '/v', ext: 'md',
    mtime: 0, ctime: 0, size: 0, tags: [], frontmatter: fm, ...over,
  }
}

const recs = [
  rec('a.md', { status: 'read', rating: 3 }, { mtime: 300 }),
  rec('b.md', { status: 'new', rating: 5 }, { mtime: 100 }),
  rec('c.md', { status: 'read', rating: 4 }, { mtime: 200 }),
]

describe('buildRows', () => {
  it('resolves cells for the given order', () => {
    const rows = buildRows(recs, ['file.name', 'note.rating'])
    expect(rows[0].cells['file.name']).toBe('a.md')
    expect(rows[0].cells['note.rating']).toBe(3)
  })
})

describe('sortRows', () => {
  it('sorts numeric descending', () => {
    const rows = buildRows(recs, ['note.rating'])
    const sorted = sortRows(rows, 'note.rating', 'DESC')
    expect(sorted.map((r) => r.record.name)).toEqual(['b.md', 'c.md', 'a.md'])
  })
  it('sorts by file.mtime ascending', () => {
    const rows = buildRows(recs, ['file.mtime'])
    const sorted = sortRows(rows, 'file.mtime', 'ASC')
    expect(sorted.map((r) => r.record.name)).toEqual(['b.md', 'c.md', 'a.md'])
  })
})

describe('groupRows', () => {
  it('groups by property and counts', () => {
    const rows = buildRows(recs, ['note.status'])
    const groups = groupRows(rows, 'note.status', 'ASC')
    expect(groups.map((g) => [g.key, g.rows.length])).toEqual([['new', 1], ['read', 2]])
  })
})

describe('displayCell', () => {
  it('joins arrays and stringifies objects', () => {
    expect(displayCell(['a', 'b'])).toBe('a, b')
    expect(displayCell({ x: 1 })).toBe('{"x":1}')
    expect(displayCell(undefined)).toBe('')
    expect(displayCell(5)).toBe('5')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/lib/base/rows.test.ts`
Expected: FAIL,`./rows` 不存在。

- [ ] **Step 3: 最小实现**

创建 `src/lib/base/rows.ts`:

```ts
import type { BaseRow, FileRecord, SortDirection } from './model'
import { resolveProp } from './filter'

/** Build display rows: resolve each ordered property into a cell value. */
export function buildRows(records: FileRecord[], order: string[]): BaseRow[] {
  return records.map((record) => {
    const cells: Record<string, unknown> = {}
    for (const prop of order) cells[prop] = resolveProp(prop, record)
    return { record, cells }
  })
}

function cmpValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const na = Number(a), nb = Number(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '') return na - nb
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base' })
}

/** Stable sort rows by a property in the given direction. */
export function sortRows(rows: BaseRow[], property: string, direction: SortDirection): BaseRow[] {
  const sign = direction === 'DESC' ? -1 : 1
  return [...rows].sort((ra, rb) =>
    sign * cmpValues(resolveProp(property, ra.record), resolveProp(property, rb.record)))
}

export interface RowGroup { key: string; rows: BaseRow[] }

/** Group rows by a property value (rendered as a string key), ordered by key. */
export function groupRows(rows: BaseRow[], property: string, direction: SortDirection): RowGroup[] {
  const map = new Map<string, BaseRow[]>()
  for (const row of rows) {
    const key = displayCell(resolveProp(property, row.record))
    const arr = map.get(key) ?? []
    arr.push(row)
    map.set(key, arr)
  }
  const sign = direction === 'DESC' ? -1 : 1
  return [...map.entries()]
    .map(([key, rs]) => ({ key, rows: rs }))
    .sort((a, b) => sign * a.key.localeCompare(b.key, undefined, { sensitivity: 'base' }))
}

/** Render any cell value as display text. */
export function displayCell(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map((x) => displayCell(x)).join(', ')
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/lib/base/rows.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/base/rows.ts src/lib/base/rows.test.ts
git commit -m "feat(base): build rows, sort, group, and display-format cells

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: base/scan.ts 递归扫描目录

**Files:**
- Create: `src/lib/base/scan.ts`
- Test: `src/lib/base/scan.test.ts`

用依赖注入(传入 `readDir`/`stat`/`readTextFile`)使其可单测,不直接静态依赖 tauri。

- [ ] **Step 1: 写失败测试**

创建 `src/lib/base/scan.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { extractFrontmatter, scanBaseDir, type ScanDeps } from './scan'

describe('extractFrontmatter', () => {
  it('parses leading YAML frontmatter and tags', () => {
    const { data, tags } = extractFrontmatter('---\nstatus: read\ntags: [a, b]\n---\nbody')
    expect(data).toEqual({ status: 'read', tags: ['a', 'b'] })
    expect(tags).toEqual(['a', 'b'])
  })
  it('returns empty for no frontmatter', () => {
    expect(extractFrontmatter('# just body').data).toEqual({})
  })
  it('normalizes a single string tag', () => {
    expect(extractFrontmatter('---\ntags: solo\n---').tags).toEqual(['solo'])
  })
})

describe('scanBaseDir', () => {
  it('recursively collects md records, skipping dotfiles and non-md', () => {
    const tree: Record<string, { name: string; isDirectory: boolean }[]> = {
      '/v': [
        { name: 'a.md', isDirectory: false },
        { name: 'note.txt', isDirectory: false },
        { name: '.hidden.md', isDirectory: false },
        { name: 'sub', isDirectory: true },
      ],
      '/v/sub': [{ name: 'b.md', isDirectory: false }],
    }
    const deps: ScanDeps = {
      readDir: async (d) => tree[d] ?? [],
      stat: async () => ({ mtime: new Date(1000), birthtime: new Date(500), size: 12 }),
      readTextFile: async (p) => (p.endsWith('a.md') ? '---\nstatus: read\n---\n' : ''),
    }
    return scanBaseDir('/v', deps).then((recs) => {
      const names = recs.map((r) => r.name).sort()
      expect(names).toEqual(['a.md', 'b.md'])
      const a = recs.find((r) => r.name === 'a.md')!
      expect(a.folder).toBe('/v')
      expect(a.mtime).toBe(1000)
      expect(a.frontmatter).toEqual({ status: 'read' })
    })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- src/lib/base/scan.test.ts`
Expected: FAIL,`./scan` 不存在。

- [ ] **Step 3: 最小实现**

创建 `src/lib/base/scan.ts`:

```ts
import { parse } from 'yaml'
import { joinPath } from '../fs'
import type { FileRecord } from './model'

// Inlined (not imported from folder-view.svelte.ts) so this module stays free of
// Tauri/runes imports and scan.test.ts runs hermetically.
const parentDir = (p: string) => {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export interface ScanDeps {
  readDir: (dir: string) => Promise<{ name: string; isDirectory: boolean }[]>
  stat: (path: string) => Promise<{ mtime?: Date | null; birthtime?: Date | null; size?: number } | null>
  readTextFile: (path: string) => Promise<string>
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/

function normalizeTags(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string') return [v]
  return []
}

/** Extract leading YAML frontmatter into an object + normalized tags. */
export function extractFrontmatter(text: string): { data: Record<string, unknown>; tags: string[] } {
  const m = FM_RE.exec(text)
  if (!m) return { data: {}, tags: [] }
  let data: Record<string, unknown> = {}
  try {
    const parsed = parse(m[1])
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch {
    data = {}
  }
  return { data, tags: normalizeTags(data.tags) }
}

const isMd = (name: string) => /\.md$/i.test(name) && !name.startsWith('.')

/** Recursively scan `dir` for markdown files → FileRecord[]. */
export async function scanBaseDir(dir: string, deps: ScanDeps): Promise<FileRecord[]> {
  const out: FileRecord[] = []
  const walk = async (d: string): Promise<void> => {
    const entries = await deps.readDir(d).catch(() => [])
    await Promise.all(entries.map(async (e) => {
      if (e.name.startsWith('.')) return
      const path = joinPath(d, e.name)
      if (e.isDirectory) return walk(path)
      if (!isMd(e.name)) return
      const [st, text] = await Promise.all([
        deps.stat(path).catch(() => null),
        deps.readTextFile(path).catch(() => ''),
      ])
      const { data, tags } = extractFrontmatter(text)
      out.push({
        path,
        name: e.name,
        folder: parentDir(path),
        ext: 'md',
        mtime: st?.mtime ? new Date(st.mtime).getTime() : 0,
        ctime: st?.birthtime ? new Date(st.birthtime).getTime() : 0,
        size: st?.size ?? 0,
        tags,
        frontmatter: data,
      })
    }))
  }
  await walk(dir)
  return out
}
```

注意:`joinPath` 从 `../fs` 导入(纯函数);`parentDir` 已内联,scan.ts 不依赖任何 Tauri/runes 模块,保证 `scan.test.ts` hermetic。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test -- src/lib/base/scan.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/base/scan.ts src/lib/base/scan.test.ts
git commit -m "feat(base): dependency-injected recursive md scanner + frontmatter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: openFile 以 rich 模式打开 .base

**Files:**
- Modify: `src/lib/tabs.svelte.ts`(`openFile` 内的 `mode` 计算行)

- [ ] **Step 1: 定位**

`grep -n "kind === 'image' || cls.kind === 'spreadsheet'" src/lib/tabs.svelte.ts`
应命中 mode 计算行(约 200 行):
```ts
const mode = (cls.kind === 'image' || cls.kind === 'spreadsheet') ? 'rich' : (getRecentMode(modeKeyFor(path)) ?? 'rich')
```

- [ ] **Step 2: 改为让 base 也默认 rich**

```ts
const mode = (cls.kind === 'image' || cls.kind === 'spreadsheet' || cls.kind === 'base') ? 'rich' : (getRecentMode(modeKeyFor(path)) ?? 'rich')
```

`.base` 是文本文件,`openFile` 走非 image 分支读文本(已有逻辑),无需别的改动。

- [ ] **Step 3: 类型检查**

Run: `pnpm check`
Expected: 无与 `tabs.svelte.ts` 相关的新错误(`FileKind` 已含 `'base'`,Task 1 已加)。

- [ ] **Step 4: 提交**

```bash
git add src/lib/tabs.svelte.ts
git commit -m "feat(base): open .base files in rich mode by default

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: BaseView.svelte + EditorPane 分派

**Files:**
- Create: `src/components/BaseView.svelte`
- Modify: `src/components/EditorPane.svelte`(在 spreadsheet 分支后加 base 分支 + import)

UI 组件走**手动 GUI 验证**(见 Task 10),不做 UI 自动化测试。

- [ ] **Step 1: 写 BaseView.svelte**

创建 `src/components/BaseView.svelte`:

```svelte
<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { openFile } from '../lib/tabs.svelte'
  import { readDir, stat, readTextFile } from '@tauri-apps/plugin-fs'
  import { parentDir } from '../lib/folder-view.svelte'
  import { parseBase } from '../lib/base/parse'
  import { scanBaseDir, type ScanDeps } from '../lib/base/scan'
  import { evalFilter } from '../lib/base/filter'
  import { buildRows, sortRows, groupRows, displayCell } from '../lib/base/rows'
  import type { FileRecord, BaseRow, SortDirection } from '../lib/base/model'
  import { t } from '../lib/i18n/store.svelte'

  let { tab }: { tab: Tab } = $props()

  const deps: ScanDeps = {
    readDir: (d) => readDir(d),
    stat: (p) => stat(p),
    readTextFile: (p) => readTextFile(p),
  }

  const config = $derived(parseBase(tab.currentContent))
  let viewIndex = $state(0)
  const view = $derived(config.views[Math.min(viewIndex, config.views.length - 1)])

  let records = $state<FileRecord[]>([])
  let loading = $state(true)
  let clickSort = $state<{ property: string; direction: SortDirection } | null>(null)

  $effect(() => {
    const dir = parentDir(tab.filePath)
    loading = true
    scanBaseDir(dir, deps)
      .then((r) => { records = r })
      .catch(() => { records = [] })
      .finally(() => { loading = false })
  })

  // 列顺序:view.order,缺省用记录里出现过的 frontmatter 键 + file.name
  const columns = $derived.by(() => {
    if (view.order?.length) return view.order
    const keys = new Set<string>(['file.name'])
    for (const r of records) for (const k of Object.keys(r.frontmatter)) keys.add('note.' + k)
    return [...keys]
  })

  const rows = $derived.by(() => {
    let filtered = records.filter((r) => evalFilter(config.filters, r) && evalFilter(view.filters, r))
    let built: BaseRow[] = buildRows(filtered, columns)
    const sort = clickSort ?? view.groupBy
    if (sort) built = sortRows(built, sort.property, sort.direction)
    if (typeof view.limit === 'number') built = built.slice(0, view.limit)
    return built
  })

  const groups = $derived.by(() =>
    view.groupBy ? groupRows(rows, view.groupBy.property, view.groupBy.direction) : null)

  const label = (col: string) => config.properties[col]?.displayName ?? col

  function toggleSort(col: string) {
    if (clickSort?.property === col) {
      clickSort = { property: col, direction: clickSort.direction === 'ASC' ? 'DESC' : 'ASC' }
    } else {
      clickSort = { property: col, direction: 'ASC' }
    }
  }

  async function open(path: string) {
    try { await openFile(path) } catch { /* ignore */ }
  }
</script>

<div class="base-view">
  <div class="base-toolbar">
    {#if config.views.length > 1}
      <select bind:value={viewIndex} class="base-view-select">
        {#each config.views as v, i}
          <option value={i} disabled={v.type !== 'table'}>{v.name}{v.type !== 'table' ? ` (${v.type})` : ''}</option>
        {/each}
      </select>
    {:else}
      <span class="base-title">{view.name}</span>
    {/if}
    <span class="base-count">{rows.length}</span>
  </div>

  {#if config.error}
    <div class="base-empty">{t('base.parseError')}</div>
  {:else if loading}
    <div class="base-empty">{t('base.loading')}</div>
  {:else if view.type !== 'table'}
    <div class="base-empty">{t('base.unsupportedView')}</div>
  {:else if rows.length === 0}
    <div class="base-empty">{t('base.empty')}</div>
  {:else}
    <table class="base-table">
      <thead>
        <tr>
          {#each columns as col}
            <th onclick={() => toggleSort(col)}>
              {label(col)}
              {#if clickSort?.property === col}<span class="sort-arrow">{clickSort.direction === 'ASC' ? '▲' : '▼'}</span>{/if}
            </th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#if groups}
          {#each groups as g}
            <tr class="group-head"><td colspan={columns.length}>{g.key || '—'} · {g.rows.length}</td></tr>
            {#each g.rows as row}
              {@render rowTr(row)}
            {/each}
          {/each}
        {:else}
          {#each rows as row}
            {@render rowTr(row)}
          {/each}
        {/if}
      </tbody>
    </table>
  {/if}
</div>

{#snippet rowTr(row: BaseRow)}
  <tr class="base-row" onclick={() => open(row.record.path)}>
    {#each columns as col, i}
      <td class:name-cell={i === 0}>{i === 0 && col === 'file.name' ? row.record.name : displayCell(row.cells[col])}</td>
    {/each}
  </tr>
{/snippet}

<style>
  .base-view { display: flex; flex-direction: column; height: 100%; overflow: auto; background: var(--bg, #fff); color: var(--fg, #222); }
  .base-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border, #e5e5e5); position: sticky; top: 0; background: inherit; z-index: 2; }
  .base-title { font-weight: 600; }
  .base-count { margin-left: auto; opacity: 0.6; font-size: 12px; }
  .base-view-select { background: inherit; color: inherit; border: 1px solid var(--border, #e5e5e5); border-radius: 4px; padding: 2px 6px; }
  .base-empty { padding: 24px; opacity: 0.6; }
  .base-table { border-collapse: collapse; width: 100%; font-size: 13px; }
  .base-table th, .base-table td { text-align: left; padding: 6px 12px; border-bottom: 1px solid var(--border, #eee); white-space: nowrap; }
  .base-table th { position: sticky; top: 37px; background: inherit; cursor: pointer; user-select: none; z-index: 1; }
  .sort-arrow { font-size: 10px; opacity: 0.7; }
  .base-row { cursor: pointer; }
  .base-row:hover { background: var(--hover, rgba(0,0,0,0.04)); }
  .name-cell { font-weight: 500; }
  .group-head td { font-weight: 600; opacity: 0.75; background: var(--hover, rgba(0,0,0,0.03)); }
</style>
```

实现时核对:`parentDir` 确实从 `../lib/folder-view.svelte` 导出(Task 6 已 grep);`t` 从 `../lib/i18n/store.svelte` 导出(与其他组件一致,如 FolderView.svelte)。若 `--bg/--fg/--border/--hover` 变量名与本仓库主题变量不符,替换为实际变量(`grep -n "^\s*--" src/app.css` 查真实变量名,如 `--color-bg` 等)。

- [ ] **Step 2: EditorPane 加分派**

在 `src/components/EditorPane.svelte` 顶部 import 区加:
```ts
import BaseView from './BaseView.svelte'
import { isPluginEnabled } from '../lib/settings.svelte'
```

在 spreadsheet 分支之后、`{:else if tab.mode === 'source'}` 之前插入:
```svelte
  {:else if tab.kind === 'base' && tab.mode !== 'source' && isPluginEnabled('base')}
    {#key tab.id}
      <BaseView {tab} />
    {/key}
```

(顺序 + 门控保证:base+source、想看原始 YAML、或插件被关时,落到后面的 `tab.mode === 'source'` 分支渲染 SourceView 原始文本。若 EditorPane 已 import 过 `isPluginEnabled`,勿重复导入。)

- [ ] **Step 3: 类型检查**

Run: `pnpm check`
Expected: 无新增错误。若报 `--bg` 等无关,忽略(CSS 变量不参与类型检查)。

- [ ] **Step 4: 提交**

```bash
git add src/components/BaseView.svelte src/components/EditorPane.svelte
git commit -m "feat(base): BaseView table renderer + EditorPane dispatch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: i18n 文案

**Files:**
- Modify: `src/lib/i18n/en.ts`, `src/lib/i18n/zh.ts`, `src/lib/i18n/ja.ts`, `src/lib/i18n/de.ts`

- [ ] **Step 1: en.ts 加键**

在 `src/lib/i18n/en.ts` 的对象内(与 `folderView.*` 同级)加:
```ts
  'base.loading': 'Scanning folder…',
  'base.empty': 'No matching files',
  'base.parseError': 'Cannot parse this .base file. Switch to source mode to edit the YAML.',
  'base.unsupportedView': 'This view type is not supported yet',
```

- [ ] **Step 2: zh.ts 加键**

```ts
  'base.loading': '正在扫描目录…',
  'base.empty': '没有匹配的文件',
  'base.parseError': '无法解析这个 .base 文件,切到源码模式修改 YAML。',
  'base.unsupportedView': '暂不支持这种视图类型',
```

- [ ] **Step 3: ja.ts 加键**

```ts
  'base.loading': 'フォルダをスキャン中…',
  'base.empty': '一致するファイルがありません',
  'base.parseError': 'この .base ファイルを解析できません。ソースモードで YAML を編集してください。',
  'base.unsupportedView': 'このビュータイプはまだ対応していません',
```

- [ ] **Step 4: de.ts 加键**

```ts
  'base.loading': 'Ordner wird gescannt…',
  'base.empty': 'Keine passenden Dateien',
  'base.parseError': 'Diese .base-Datei kann nicht geparst werden. Wechsle in den Quelltextmodus, um das YAML zu bearbeiten.',
  'base.unsupportedView': 'Dieser Ansichtstyp wird noch nicht unterstützt',
```

注意:`zh/ja/de` 是 `Partial` 目录,只需加这四个键;确认放在对象字面量内、逗号闭合。`grep -n "folderView.find" src/lib/i18n/zh.ts` 找个落点参考缩进。

- [ ] **Step 5: 类型检查 + 提交**

Run: `pnpm check`
Expected: 无新错误。

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/ja.ts src/lib/i18n/de.ts
git commit -m "i18n(base): strings for loading/empty/parse-error/unsupported-view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 全量校验 + 手动 GUI 冒烟

**Files:** 无(验证任务)

- [ ] **Step 1: 全量测试 + 类型检查**

Run: `pnpm test && pnpm check`
Expected: 全绿。

- [ ] **Step 2: 造样例数据**

在某测试目录建三个 md(带 frontmatter)与一个 `library.base`:

`library.base`:
```yaml
properties:
  note.status:
    displayName: Status
  note.rating:
    displayName: Rating
filters:
  and:
    - file.hasTag("book")
views:
  - type: table
    name: Library
    order: [file.name, note.status, note.rating]
    groupBy:
      property: note.status
      direction: ASC
```

每个 md 顶部:
```yaml
---
tags: [book]
status: read
rating: 4
---
```

- [ ] **Step 3: 起 dev 构建**

Run: `pnpm tauri dev`(或用户既有 dev 流程)。

- [ ] **Step 4: 手动核对(交给用户,按"我自己测 GUI"约定)**

给用户这份手动清单:
1. 用 folder-view 打开测试目录,能看到 `library.base`。
2. 点开 `library.base` → 出现表格 tab,列头为 Status/Rating,首列文件名。
3. 只显示带 `tags: [book]` 的文件;改一个 md 去掉 book tag → 手动刷新/重开后该行消失(v1 无自动监听)。
4. 按 status 分组,组标题带计数。
5. 点列头 → 排序方向切换,箭头出现。
6. 点某行 → 当前区打开对应 md。
7. 顶栏切 source 模式 → 看到原始 YAML;切回 → 回到表格。
8. 设置里关闭 base 插件后重启 → `.base` 以文本/源码打开(不再是表格)。
   - (注:插件门控若未在 v1 接线,则此条标记为已知限制;见下)

- [ ] **Step 5: 提交(如样例数据要入库则精确 add;否则丢弃)**

样例数据一般不入库。若需要保留冒烟样例,放 `docs/` 下并精确 add。

---

## 已知限制 / v1 未接线项(实现时确认)

- **文件监听**:v1 不自动重扫(设计第 11 节默认 4);改动 md 后需重开或手动刷新。
- **`file.hasLink` / 正文 `#tag` / formulas / summaries / cards**:v1 不生效(fail-open / 忽略),`.base` 字段保留不丢。
