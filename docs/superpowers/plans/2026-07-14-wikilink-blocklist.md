# 无效 wikilink 黑名单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 命中"无效 wikilink 清单"的 `[[X]]` 不渲染为链接、不可点、不进 backlink 索引、不派生成大纲条目；清单存 `vault/wikilink/blocklist.md`（用户可编辑，首次用默认 `wikilink`/`链接`/`双链` 播种）。

**Architecture:** 纯逻辑单元 `wikilink/blocklist.ts`（默认空 Set，`isBlockedWikilink` 供各识别器调用）+ vault I/O 单元 `wikilink/blocklist-io.svelte.ts`（播种/读取/watch 重载/响应式版本号）。接入 3 处识别器：`parser.ts`（一处覆盖显示+索引+recall）、`derive.ts`、`wikilink-plugin.ts`。

**Tech Stack:** TypeScript + Svelte 5（runes）+ Vitest + `@tauri-apps/plugin-fs`（exists/writeTextFile/readTextFile/mkdir/watchImmediate）。

**Spec:** `docs/superpowers/specs/2026-07-14-wikilink-blocklist-design.md`

---

## File Structure

- **Create** `src/lib/wikilink/blocklist.ts` — 纯：`DEFAULT_BLOCKED_WIKILINKS`、`normalizeWikilinkTarget`、`parseBlocklistFile`、`setBlockedWikilinks`、`isBlockedWikilink`（模块级 Set，默认空）。
- **Create** `src/lib/wikilink/blocklist.test.ts` — 纯单测。
- **Create** `src/lib/wikilink/blocklist-io.svelte.ts` — vault 播种/读取/watch + 响应式 `wikilinkBlocklistState.version`。
- **Modify** `src/lib/outline/parser.ts` — `[[X]]` 命中黑名单 → 字面文本。
- **Modify** `src/lib/outline/parser.test.ts` / `backlinks.test.ts` — 命中项不成 page-link / 不进索引。
- **Modify** `src/lib/outline/derive.ts` / `derive.test.ts` — 命中项不派生。
- **Modify** `src/lib/wikilink-plugin.ts` — 命中项不装饰。
- **Modify** `src/lib/outline/dirs.svelte.ts` — 加 `wikilink` 目录名。
- **Modify** `src/components/outline/InlineRender.svelte` — 订阅 `wikilinkBlocklistState.version` 以在重载后重渲染。
- **Modify** `src/App.svelte` — vault root 变化时 `ensureWikilinkBlocklist()`。

---

## Task 1: 纯 blocklist 模块

**Files:**
- Create: `src/lib/wikilink/blocklist.ts`
- Test: `src/lib/wikilink/blocklist.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/lib/wikilink/blocklist.test.ts`:
```ts
// src/lib/wikilink/blocklist.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import {
  DEFAULT_BLOCKED_WIKILINKS, normalizeWikilinkTarget, parseBlocklistFile,
  setBlockedWikilinks, isBlockedWikilink,
} from './blocklist'

afterEach(() => setBlockedWikilinks([]))  // 复位模块级 Set，避免污染

describe('normalizeWikilinkTarget', () => {
  it('strips |alias and #heading, trims, lowercases', () => {
    expect(normalizeWikilinkTarget('  Foo|Bar ')).toBe('foo')
    expect(normalizeWikilinkTarget('Foo#Sec')).toBe('foo')
    expect(normalizeWikilinkTarget('WIKILINK')).toBe('wikilink')
    expect(normalizeWikilinkTarget('  ')).toBe('')
  })
})

describe('parseBlocklistFile', () => {
  it('skips front-matter / blank / headings, strips list markers', () => {
    const md = '---\ntitle: x\n---\n# 清单\n- wikilink\n* 链接\n\n  双链\n'
    expect(parseBlocklistFile(md)).toEqual(['wikilink', '链接', '双链'])
  })
  it('empty input → []', () => {
    expect(parseBlocklistFile('')).toEqual([])
  })
})

describe('isBlockedWikilink / setBlockedWikilinks', () => {
  it('default (unset) blocks nothing', () => {
    expect(isBlockedWikilink('wikilink')).toBe(false)
  })
  it('blocks case-insensitively, alias/heading-insensitively after set', () => {
    setBlockedWikilinks(DEFAULT_BLOCKED_WIKILINKS)
    expect(isBlockedWikilink('wikilink')).toBe(true)
    expect(isBlockedWikilink('WikiLink')).toBe(true)
    expect(isBlockedWikilink('wikilink|别名')).toBe(true)
    expect(isBlockedWikilink('链接#节')).toBe(true)
    expect(isBlockedWikilink('双链')).toBe(true)
    expect(isBlockedWikilink('wikilink2')).toBe(false)
    expect(isBlockedWikilink('my wikilink')).toBe(false)
  })
  it('re-setting replaces the previous set', () => {
    setBlockedWikilinks(['a'])
    setBlockedWikilinks(['b'])
    expect(isBlockedWikilink('a')).toBe(false)
    expect(isBlockedWikilink('b')).toBe(true)
  })
  it('DEFAULT_BLOCKED_WIKILINKS is the seed list', () => {
    expect(DEFAULT_BLOCKED_WIKILINKS).toEqual(['wikilink', '链接', '双链'])
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run src/lib/wikilink/blocklist.test.ts`
Expected: FAIL — `Failed to resolve import "./blocklist"`.

- [ ] **Step 3: 实现**

Create `src/lib/wikilink/blocklist.ts`:
```ts
// src/lib/wikilink/blocklist.ts
// 无效 wikilink 黑名单：纯逻辑，模块级 Set（默认空 → 未加载/测试时不拦截）。
// vault 加载器（blocklist-io）解析清单后调 setBlockedWikilinks 灌入。

/** 随版本发布的默认清单，也是首次播种 vault/wikilink/blocklist.md 的内容源。 */
export const DEFAULT_BLOCKED_WIKILINKS = ['wikilink', '链接', '双链']

/** 剥 |别名 与 #标题（取页名），trim，toLowerCase。 */
export function normalizeWikilinkTarget(raw: string): string {
  return raw.split('|')[0].split('#')[0].trim().toLowerCase()
}

/**
 * markdown 列表文本 → 条目数组：跳过 --- front-matter 块、空行、# 标题；
 * 剥行首 - / * / + 列表符号；trim；非空即一条（原样，不 normalize —— 由
 * setBlockedWikilinks 统一 normalize）。
 */
export function parseBlocklistFile(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/)
  const out: string[] = []
  let inFrontmatter = false
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    if (idx === 0 && line.trim() === '---') { inFrontmatter = true; continue }
    if (inFrontmatter) { if (line.trim() === '---') inFrontmatter = false; continue }
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const item = trimmed.replace(/^[-*+]\s+/, '').trim()
    if (item) out.push(item)
  }
  return out
}

let blocked = new Set<string>()

/** 用给定清单重建模块级 Set（每项 normalize，丢弃空串）。 */
export function setBlockedWikilinks(list: string[]): void {
  blocked = new Set(list.map(normalizeWikilinkTarget).filter(Boolean))
}

/** normalize(target) 是否在当前黑名单里。 */
export function isBlockedWikilink(target: string): boolean {
  const key = normalizeWikilinkTarget(target)
  return key !== '' && blocked.has(key)
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm exec vitest run src/lib/wikilink/blocklist.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: Commit（精确 add；共享 worktree，禁用 `git add -A`/`.`）**

```bash
git add src/lib/wikilink/blocklist.ts src/lib/wikilink/blocklist.test.ts
git commit -m "feat(wikilink): pure invalid-wikilink blocklist (default empty, case/alias-insensitive)"
```

---

## Task 2: parser 接入（覆盖显示 + 索引 + recall）

**Files:**
- Modify: `src/lib/outline/parser.ts`（import + `[[` 分支）
- Test: `src/lib/outline/parser.test.ts`、`src/lib/outline/backlinks.test.ts`

`parser.ts` 是纯模块，`isBlockedWikilink` 默认空 Set → 不设黑名单时行为完全不变。

- [ ] **Step 1: 写失败测试（parser + backlinks）**

在 `src/lib/outline/parser.test.ts` 顶部 import 追加：
```ts
import { setBlockedWikilinks } from '../wikilink/blocklist'
```
在文件末尾（最后一个 `})` 关闭 describe 之前的合适位置）追加一个 describe：
```ts
describe('blocklisted wikilinks render as literal text', () => {
  afterEach(() => setBlockedWikilinks([]))
  it('blocked [[X]] → text token (literal), unblocked stays page-link', () => {
    setBlockedWikilinks(['wikilink', '链接'])
    expect(parseInline('[[wikilink]]')).toEqual([{ t: 'text', text: '[[wikilink]]' }])
    expect(parseInline('see [[链接]] here')).toEqual([{ t: 'text', text: 'see [[链接]] here' }])
    expect(parseInline('[[Real]]')).toEqual([{ t: 'page-link', target: 'Real' }])
  })
})
```
`parser.test.ts` 需要 `afterEach` —— 在顶部 `import { describe, it, expect } from 'vitest'` 改为 `import { describe, it, expect, afterEach } from 'vitest'`。

在 `src/lib/outline/backlinks.test.ts` 顶部 import 追加：
```ts
import { setBlockedWikilinks } from '../wikilink/blocklist'
import { afterEach } from 'vitest'
```
（若该文件已从 'vitest' import 了 describe/it/expect，则把 afterEach 合并进那一行而不是新增行。）在 `describe('index', …)` 块内追加：
```ts
  it('does not index blocklisted wikilinks', () => {
    setBlockedWikilinks(['wikilink'])
    const idx = createIndex()
    indexFileContent(idx, '/d/a.notes.md', '- [[wikilink]] and [[Real]]\n')
    expect(backlinksFor(idx, 'wikilink')).toEqual([])
    expect(backlinksFor(idx, 'real')).toHaveLength(1)
    setBlockedWikilinks([])
  })
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run src/lib/outline/parser.test.ts src/lib/outline/backlinks.test.ts`
Expected: FAIL — 现在 `[[wikilink]]` 仍解析成 `{t:'page-link'}` 并被索引。

- [ ] **Step 3: 实现 parser.ts**

在 `src/lib/outline/parser.ts` 顶部（`export type Inline` 之前或 import 区）加：
```ts
import { isBlockedWikilink } from '../wikilink/blocklist'
```
把 `parseInline` 里的 `[[` 分支：
```ts
    if (two === '[[') {
      const end = findPageLinkEnd(input, i + 2)
      if (end >= 0) { flush(); out.push({ t: 'page-link', target: input.slice(i + 2, end) }); i = end + 2; continue }
    }
```
改为：
```ts
    if (two === '[[') {
      const end = findPageLinkEnd(input, i + 2)
      if (end >= 0) {
        const target = input.slice(i + 2, end)
        // 黑名单命中：保留字面 [[…]] 作普通文本，不产链接（→ 不渲染、不索引、不 recall）
        if (isBlockedWikilink(target)) { text += `[[${target}]]` }
        else { flush(); out.push({ t: 'page-link', target }) }
        i = end + 2; continue
      }
    }
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm exec vitest run src/lib/outline/parser.test.ts src/lib/outline/backlinks.test.ts`
Expected: PASS（新用例通过；原有用例仍绿——默认空 Set 不影响）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/parser.ts src/lib/outline/parser.test.ts src/lib/outline/backlinks.test.ts
git commit -m "feat(wikilink): blocklisted [[X]] parse as literal text (no link, no backlink)"
```

---

## Task 3: derive 接入（不派生成大纲条目）

**Files:**
- Modify: `src/lib/outline/derive.ts`
- Test: `src/lib/outline/derive.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/outline/derive.test.ts` 顶部 import 追加：
```ts
import { setBlockedWikilinks } from '../wikilink/blocklist'
```
把顶部 vitest import 加上 `afterEach`（若尚未有）。追加：
```ts
describe('blocklisted wikilinks are not derived', () => {
  afterEach(() => setBlockedWikilinks([]))
  it('skips a blocklisted [[X]], keeps a normal one', () => {
    setBlockedWikilinks(['wikilink'])
    const items = deriveAutoItems('## A\n[[wikilink]]\n[[Real]] here\n')
    expect(items.map(i => i.source)).toEqual(['toc', 'wikilink'])
    expect(items.find(i => i.source === 'wikilink')!.content).toContain('[[Real]]')
  })
})
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm exec vitest run src/lib/outline/derive.test.ts`
Expected: FAIL — 当前 `[[wikilink]]` 也会派生一条 wikilink（sources = ['toc','wikilink','wikilink']）。

- [ ] **Step 3: 实现 derive.ts**

在 `src/lib/outline/derive.ts` 顶部 import 区加：
```ts
import { isBlockedWikilink } from '../wikilink/blocklist'
```
把 wikilink 分支：
```ts
      if (m[6] != null) {
        // wikilink：整句为内容（保留 [[…]]），同句去重
```
改为（在分支体第一行插入守卫）：
```ts
      if (m[6] != null) {
        if (isBlockedWikilink(m[6])) continue   // 黑名单命中：不派生成大纲条目
        // wikilink：整句为内容（保留 [[…]]），同句去重
```

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm exec vitest run src/lib/outline/derive.test.ts`
Expected: PASS（含既有 derive 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/derive.ts src/lib/outline/derive.test.ts
git commit -m "feat(wikilink): don't derive blocklisted [[X]] into outline items"
```

---

## Task 4: 主编辑器装饰接入（不装饰、不可点）

**Files:**
- Modify: `src/lib/wikilink-plugin.ts`

无单元测试（ProseMirror 装饰不易纯单测）；靠 Task 1 的 `isBlockedWikilink` 单测 + Task 6 手动冒烟。

- [ ] **Step 1: 加 import + 守卫**

在 `src/lib/wikilink-plugin.ts` 顶部 import 区加：
```ts
import { isBlockedWikilink } from './wikilink/blocklist'
```
在 `buildDecorations` 里，wikilink 循环的这段：
```ts
      const target = m[1].split('|')[0].trim()
      if (!target) continue
      decos.push(
        Decoration.inline(from, to, {
          nodeName: 'span',
          class: 'wikilink',
          'data-wikilink': target,
        }),
      )
```
改为（在 `decos.push` 前加一行守卫）：
```ts
      const target = m[1].split('|')[0].trim()
      if (!target) continue
      if (isBlockedWikilink(target)) continue   // 黑名单命中：不装饰 → 无样式、无 data-wikilink、点击不触发 openWikilink
      decos.push(
        Decoration.inline(from, to, {
          nodeName: 'span',
          class: 'wikilink',
          'data-wikilink': target,
        }),
      )
```

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 无新增 error（`wikilink-plugin.ts` / `blocklist.ts` 类型正确）。

- [ ] **Step 3: Commit**

```bash
git add src/lib/wikilink-plugin.ts
git commit -m "feat(wikilink): don't decorate blocklisted [[X]] in the rich editor"
```

---

## Task 5: vault 目录 + I/O 加载器 + 响应式订阅 + App 挂载

**Files:**
- Modify: `src/lib/outline/dirs.svelte.ts`
- Create: `src/lib/wikilink/blocklist-io.svelte.ts`
- Modify: `src/components/outline/InlineRender.svelte`
- Modify: `src/App.svelte`

vault I/O 依赖 Tauri fs，不做纯单测；`parseBlocklistFile` 已在 Task 1 单测覆盖。靠 `pnpm check` + Task 6 手动冒烟。

- [ ] **Step 1: dirs 加 wikilink 目录**

在 `src/lib/outline/dirs.svelte.ts`：
```ts
export const DEFAULT_DIRS = { wikipage: 'wikipage', dailynote: 'dailynote' } as const
export const outlineDirs = $state<{ wikipage: string; dailynote: string }>({ ...DEFAULT_DIRS })
```
改为：
```ts
export const DEFAULT_DIRS = { wikipage: 'wikipage', dailynote: 'dailynote', wikilink: 'wikilink' } as const
export const outlineDirs = $state<{ wikipage: string; dailynote: string; wikilink: string }>({ ...DEFAULT_DIRS })
```
（`loadOutlineDirs` 不需要改：`wikilink` 保持默认值 `'wikilink'`，不做用户可配置目录名。）

- [ ] **Step 2: 创建 blocklist-io**

Create `src/lib/wikilink/blocklist-io.svelte.ts`:
```ts
// src/lib/wikilink/blocklist-io.svelte.ts
// vault/wikilink/blocklist.md 的播种 / 读取 / watch 重载。
// 响应式 wikilinkBlocklistState.version 供显示层订阅（重载后重渲染）。
import { sotvaultStore } from '../sotvault.svelte'
import { outlineDirs } from '../outline/dirs.svelte'
import { joinPath } from '../fs'
import { DEFAULT_BLOCKED_WIKILINKS, parseBlocklistFile, setBlockedWikilinks } from './blocklist'

export const wikilinkBlocklistState = $state<{ version: number }>({ version: 0 })

let unwatch: (() => void) | null = null
let watchedPath: string | null = null

function defaultFileText(): string {
  return '# 无效 wikilink 清单（此处列出的不会渲染为链接、不可点、不进关系索引）\n'
    + DEFAULT_BLOCKED_WIKILINKS.map((w) => `- ${w}`).join('\n') + '\n'
}

async function loadFrom(path: string): Promise<void> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  const text = await readTextFile(path)
  setBlockedWikilinks(parseBlocklistFile(text))
  wikilinkBlocklistState.version++
}

/**
 * 依当前 vault 根，确保 blocklist.md 存在（不存在则用默认三条播种）、
 * 加载进纯 Set、并监听变更。无 vault 时 no-op（黑名单保持空）。
 * 幂等：vault 未变时重复调用只重新加载一次。
 */
export async function ensureWikilinkBlocklist(): Promise<void> {
  const vault = sotvaultStore.vaultRoot
  if (!vault) return
  const dir = joinPath(vault, outlineDirs.wikilink)
  const path = joinPath(dir, 'blocklist.md')
  try {
    const { exists, mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs')
    if (!(await exists(path).catch(() => false))) {
      await mkdir(dir, { recursive: true }).catch(() => {})
      await writeTextFile(path, defaultFileText())
    }
    await loadFrom(path)
    if (watchedPath !== path) {
      if (unwatch) { try { unwatch() } catch { /* ignore */ } unwatch = null }
      watchedPath = path
      const { watchImmediate } = await import('@tauri-apps/plugin-fs')
      watchImmediate(path, () => { void loadFrom(path).catch((e) => console.warn('[wikilink] reload blocklist failed:', e)) })
        .then((s) => { unwatch = s })
        .catch((e) => console.warn('[wikilink] watch blocklist failed:', e))
    }
  } catch (e) {
    console.warn('[wikilink] ensure blocklist failed:', e)
  }
}
```

- [ ] **Step 3: InlineRender 订阅版本号**

在 `src/components/outline/InlineRender.svelte` 的 `<script>` 里，import 后把
```ts
  let segments = $derived(parseInline(content))
```
改为：
```ts
  import { wikilinkBlocklistState } from '../../lib/wikilink/blocklist-io.svelte'
  let segments = $derived.by(() => { void wikilinkBlocklistState.version; return parseInline(content) })
```
（`import` 放在 `<script>` 顶部已有 import 之后；`$derived.by` 读 version 使黑名单重载后重渲染。）

- [ ] **Step 4: App 挂载（vault root 变化时加载）**

在 `src/App.svelte` 的 import 区加：
```ts
  import { ensureWikilinkBlocklist } from './lib/wikilink/blocklist-io.svelte'
```
把现有的：
```ts
    setVaultRootChangedHandler(() => { void maybeInstallTracker() })
    void maybeInstallTracker().catch((e) => console.warn('[App] insights tracker init:', e))
```
改为：
```ts
    setVaultRootChangedHandler(() => { void maybeInstallTracker(); void ensureWikilinkBlocklist() })
    void maybeInstallTracker().catch((e) => console.warn('[App] insights tracker init:', e))
    void ensureWikilinkBlocklist().catch((e) => console.warn('[App] wikilink blocklist init:', e))
```

- [ ] **Step 5: 类型检查**

Run: `pnpm check`
Expected: 无新增 error（dirs/blocklist-io/InlineRender/App 类型正确）。

- [ ] **Step 6: Commit**

```bash
git add src/lib/outline/dirs.svelte.ts src/lib/wikilink/blocklist-io.svelte.ts src/components/outline/InlineRender.svelte src/App.svelte
git commit -m "feat(wikilink): load user-editable blocklist from vault/wikilink/blocklist.md"
```

---

## Task 6: 全量校验 + 手动冒烟

**Files:** none（verification only）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: PASS（全绿，含新 `blocklist.test.ts` 与各 `*.test.ts` 新用例；既有用例不受影响——默认空 Set）。

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 无新增 error。

- [ ] **Step 3: 手动冒烟（记录每条 pass/fail）**

启动 dev、打开一个 vault：
1. 确认 `vault/wikilink/blocklist.md` 被自动创建，内容含 `- wikilink` / `- 链接` / `- 双链`。
2. 在一个 `.note.md` 大纲节点里写 `[[wikilink]]` 和 `[[真实页]]` → `[[wikilink]]` 显示为纯文本、不可点；`[[真实页]]` 是蓝色可点链接。
3. 主富文本编辑器里写 `[[链接]]` → 无链接样式、点击无反应。
4. 确认 Linked References / backlink 里没有 `wikilink`/`链接`/`双链` 的关系。
5. 编辑 `vault/wikilink/blocklist.md` 加一行 `- 测试屏蔽`，保存 → 已打开的含 `[[测试屏蔽]]` 的节点应在稍后变成纯文本（watch 重载 + InlineRender 重渲染）。
6. 大小写：`[[Wikilink]]` 也应被屏蔽。

---

## Self-Review Notes

- **Spec coverage:** 纯逻辑+默认空→Task 1；显示/索引/recall（parser 一处）→Task 2；派生→Task 3；编辑器装饰不响应→Task 4；vault 存储/播种/用户可编辑/watch 重载/dirs/响应式订阅/App 挂载→Task 5；未打开 vault 不拦截→Task 1（默认空 Set）+ Task 5（`ensureWikilinkBlocklist` 无 vault no-op）；匹配语义（大小写/别名/标题）→Task 1 单测。
- **Type consistency:** `isBlockedWikilink(target: string): boolean`、`setBlockedWikilinks(list: string[])`、`parseBlocklistFile(text): string[]`、`wikilinkBlocklistState.version: number`——各处签名一致。parser 的 `[[` 分支 `text += ...` 走既有 flush 机制产出 text token。
- **No placeholders:** 每步含完整代码/命令/预期。
