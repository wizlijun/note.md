# `.note.md` 基础功能升级 — 第二期:大纲全屏 tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件启用时 `.note.md` 以全屏大纲编辑器 tab 打开(树变更序列化回 `tab.currentContent`,复用 tabs 全部保存/脏标记/外部变更机制);伴生侧边栏改为只读预览+跳转;FolderView 对 `.note.md` 做配对合并呈现。

**Architecture:** 全局 outline store 的**编辑语义**独占给全屏编辑器(同一时刻只有活动 tab 渲染编辑器,天然单实例,无需 store 实例化);面板改用**本地解析树 + 只读渲染组件**,与全局 store 解耦,消除双写。store 的文件 IO 管线(flushSave/外部冲突)整体删除——tab 体系接管 IO。检测 `.note.md` 用**渲染期 gate**(`isOutlineNoteTab`)而非新增 FileKind:行为与 spec §3 完全一致(启用→大纲视图,禁用→markdown 编辑器),但插件开关即时生效且零 tabs 体系改动(与 spec 的"新 kind"机制描述有意偏离,行为无偏离)。

**Tech Stack:** Svelte 5 runes、TypeScript、vitest、@tauri-apps/plugin-fs

**Spec:** `docs/superpowers/specs/2026-07-10-outline-note-base-design.md` §3、§4、§4.5

**任务顺序有依赖:面板只读化(Task 3)必须先于编辑器(Task 4)落地,否则旧面板的 `detach()` 会清掉编辑器挂载的全局树。每个任务保持绿灯可独立提交。**

---

### Task 1: store 新 API — attachDoc / serializeDoc / 变更 sink(旧 API 暂留)

**Files:**
- Modify: `src/lib/outline/store.svelte.ts`
- Test: `src/lib/outline/store.test.ts`

- [ ] **Step 1: 写失败测试** — `store.test.ts` 追加:

```ts
import { outline, attachDoc, serializeDoc, setChangeSink, markDirty, detach } from './store.svelte'

describe('attachDoc / serializeDoc', () => {
  it('parses text (front-matter carried) and serializeDoc stamps title/updated', async () => {
    await attachDoc('/v/foo.note.md', '- hello\n', null)
    expect(outline.docPath).toBe('/v/foo.note.md')
    const out = serializeDoc()
    expect(out).toContain('title: foo')
    expect(out).toContain('updated:')
    expect(out).toContain('- hello')
    detach()
  })
  it('derives auto items from main content when provided', async () => {
    await attachDoc('/v/doc.note.md', '- manual\n', '# Heading One\n\ntext\n')
    const contents = [...outline.tree.nodes.values()].map(n => n.content)
    expect(contents).toContain('manual')
    expect(contents.length).toBeGreaterThan(1) // 至少派生出一个 auto 节点
    detach()
  })
  it('markDirty invokes the registered change sink', async () => {
    await attachDoc('/v/foo.note.md', '- x\n', null)
    let called = 0
    setChangeSink(() => { called++ })
    markDirty()
    expect(called).toBe(1)
    setChangeSink(null)
    detach()
  })
})
```

注意:`attachDoc` 里 stat birthtime 走 `@tauri-apps/plugin-fs` 动态导入,vitest 环境不可用——实现必须 `.catch(() => null)` 吞掉,测试才可过。

- [ ] **Step 2:** `pnpm vitest run src/lib/outline/store.test.ts` → FAIL(无 attachDoc 导出)

- [ ] **Step 3: 实现** — `store.svelte.ts`:

`OutlineState` 增加字段(旧字段暂留,Task 3 删):

```ts
  /** 全屏大纲 tab 模式:当前挂载的 .note.md 路径 */
  docPath: string | null
```

(初始 `docPath: null` 加入 `outline` 的 `$state` 初始化。)

新增(放在现有 IO 管线区之前):

```ts
// ---------- 全屏大纲 tab 模式(phase 2):IO 由 tabs 体系接管,这里只有内存树 ----------

let changeSink: (() => void) | null = null
/** 编辑器注册:任何树变更(markDirty)后被调用,负责 serializeDoc → setContent(tab) */
export function setChangeSink(fn: (() => void) | null): void { changeSink = fn }

/**
 * 挂载一篇 .note.md 文本到全局树。mainContent 非 null(伴生笔记)时对主文档
 * 跑一次派生同步(spec §4:派生移到大纲 tab 挂载时)。不写盘、不触发 sink。
 */
export async function attachDoc(docPath: string, text: string, mainContent: string | null): Promise<void> {
  outline.docPath = docPath
  outline.tree = parseOutline(text)
  outline.editingId = null
  outline.selectedIds = new Set()
  outline.selectionAnchor = null
  // 存量文件缺 created → 补文件 birthtime(测试环境 stat 不可用,静默跳过)
  if (!fmHas(outline.tree.frontmatter, 'created')) {
    const info = await import('@tauri-apps/plugin-fs')
      .then(m => m.stat(docPath)).catch(() => null)
    if (info?.birthtime) {
      outline.tree.frontmatter = touchFrontmatter(outline.tree.frontmatter, {
        title: pageNameOf(docPath), created: new Date(info.birthtime).toISOString(),
      })
    }
  }
  if (mainContent != null) syncAutoItems(outline.tree, deriveAutoItems(mainContent))
  bump()
}

/** 序列化当前树(含 title/created 补齐 + updated 刷新)。编辑器 sink 与保存共用。 */
export function serializeDoc(): string {
  if (outline.docPath) {
    outline.tree.frontmatter = touchFrontmatter(outline.tree.frontmatter, {
      title: pageNameOf(outline.docPath),
    })
  }
  return serializeOutline(outline.tree, new Set([...persistIdsFor(outline.tree), ...pinnedIds]))
}
```

顶部 import 增补:`import { touchFrontmatter, fmHas } from './frontmatter'`(`pageNameOf`、`deriveAutoItems`、`syncAutoItems` 已有)。

`markDirty` 改为双通道(旧 debounce 写盘暂留,sink 新增;Task 3 删旧通道):

```ts
export function markDirty(): void {
  if (changeSink) { changeSink(); return }   // tab 模式:同步通知编辑器
  outline.dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushSave() }, 800)
}
```

`detach()` 增加一行 `outline.docPath = null`。

- [ ] **Step 4:** `pnpm vitest run src/lib/outline` → PASS;`pnpm check` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/store.svelte.ts src/lib/outline/store.test.ts
git commit -m "feat(outline): attachDoc/serializeDoc/change-sink — tab-mode store API"
```

---

### Task 2: isOutlineNoteTab gate + ensureOutlineFile 创建工具

**Files:**
- Modify: `src/lib/outline/gate.svelte.ts`
- Create: `src/lib/outline/create.ts`
- Test: `src/lib/outline/create.test.ts`

- [ ] **Step 1: 写失败测试** — 新建 `create.test.ts`:

```ts
// src/lib/outline/create.test.ts
import { describe, it, expect } from 'vitest'
import { newOutlineFileText } from './create'

describe('newOutlineFileText', () => {
  it('produces front-matter (title/created/updated) + one empty bullet', () => {
    const text = newOutlineFileText('我的笔记', '2026-07-10T09:00:00.000Z')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('title: 我的笔记')
    expect(text).toContain('created: 2026-07-10T09:00:00.000Z')
    expect(text).toContain('updated: 2026-07-10T09:00:00.000Z')
    expect(text.endsWith('---\n- \n') || text.endsWith('---\n-\n')).toBe(true)
  })
})
```

- [ ] **Step 2:** `pnpm vitest run src/lib/outline/create.test.ts` → FAIL(模块不存在)

- [ ] **Step 3: 实现**

`create.ts`:

```ts
// src/lib/outline/create.ts
import { touchFrontmatter } from './frontmatter'
import { pageNameOf } from './backlinks'

/** 新大纲文件的完整文本:front-matter + 单个空节点(空大纲) */
export function newOutlineFileText(title: string, now?: string): string {
  const fm = touchFrontmatter(null, { title, now })
  return `---\n${fm}\n---\n- \n`
}

/** 确保 .note.md 存在(不存在则以空大纲创建),返回 path 供 openFile 使用 */
export async function ensureOutlineFile(path: string): Promise<string> {
  const { exists, writeTextFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path).catch(() => false))) {
    await writeTextFile(path, newOutlineFileText(pageNameOf(path)))
  }
  return path
}
```

`gate.svelte.ts` 追加(顶部 import `OUTLINE_SUFFIX_RE` from `./store.svelte`、`platform` from `../platform.svelte`):

```ts
let isIos = false
void platform().then((p) => { isIos = p === 'ios' })

/** 全屏大纲 tab gate:插件启用 + 桌面端 + .note.md/.notes.md 后缀(spec §3)。
 *  outlineGate.enabled 是 $state,在组件 $derived 中调用可随插件开关即时切换。 */
export function isOutlineNoteTab(tab: { kind: string; filePath: string }): boolean {
  return !isIos && outlineGate.enabled && tab.kind === 'markdown' && OUTLINE_SUFFIX_RE.test(tab.filePath)
}
```

- [ ] **Step 4:** `pnpm vitest run src/lib/outline` → PASS;`pnpm check` → 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/lib/outline/gate.svelte.ts src/lib/outline/create.ts src/lib/outline/create.test.ts
git commit -m "feat(outline): isOutlineNoteTab gate + ensureOutlineFile creator"
```

---

### Task 3: 伴生侧边栏只读化(本地树 + ReadonlyNode),删除 store 文件 IO 管线

**Files:**
- Create: `src/components/outline/ReadonlyNode.svelte`
- Rewrite: `src/components/outline/OutlinePanel.svelte`
- Modify: `src/components/outline/BacklinksSection.svelte`(prop 化)
- Modify: `src/lib/outline/backlinks-io.svelte.ts`(`outline.mainPath` → `outline.docPath`)
- Modify: `src/lib/outline/store.svelte.ts`(删旧 IO 管线)
- Modify: `src/lib/i18n/en.ts`、`zh.ts`、`ja.ts`(新增 `outline.editNote`)
- Test: 现有测试全绿(本任务以删代码为主,组件层走 Task 6 实机验证)

- [ ] **Step 1: ReadonlyNode.svelte(新,只读递归渲染,不碰全局 store)**

```svelte
<script lang="ts">
  import ReadonlyNode from './ReadonlyNode.svelte'
  import InlineRender from './InlineRender.svelte'
  import { childrenOf, type OutlineTree, type OutlineNode as NodeT } from '../../lib/outline/model'
  import { SvelteSet } from 'svelte/reactivity'

  let { node, depth, tree, collapsed, onNodeClick, onPageClick }: {
    node: NodeT
    depth: number
    tree: OutlineTree
    /** 面板本地折叠状态(不持久化) */
    collapsed: SvelteSet<string>
    onNodeClick: (n: NodeT) => void
    onPageClick: (target: string) => void
  } = $props()

  let kids = $derived(childrenOf(tree, node.id))
  let isCollapsed = $derived(collapsed.has(node.id))
</script>

<div class="node" style="--depth: {depth}">
  <div class="row" class:auto={node.source !== 'manual'}>
    {#if kids.length > 0}
      <button class="tri" class:closed={isCollapsed}
        onclick={() => { if (isCollapsed) collapsed.delete(node.id); else collapsed.add(node.id) }}>▾</button>
    {:else}<span class="tri-spacer"></span>{/if}
    <span class="bullet"
      class:src-toc={node.source === 'toc'}
      class:src-hl={node.source === 'highlight'}
      class:src-wl={node.source === 'wikilink'}>•</span>
    <span class="content" onclick={() => onNodeClick(node)} role="button" tabindex="0"
      onkeydown={(e) => { if (e.key === 'Enter') onNodeClick(node) }}>
      {#if node.content === ''}{'​'}{:else}<InlineRender content={node.content} {onPageClick} />{/if}
    </span>
  </div>
  {#if !isCollapsed}
    {#each kids as child (child.id)}
      <ReadonlyNode node={child} depth={depth + 1} {tree} {collapsed} {onNodeClick} {onPageClick} />
    {/each}
  {/if}
</div>

<style>
  .row {
    display: flex; align-items: flex-start; gap: 4px;
    padding: 1px 4px 1px calc(var(--depth) * 16px + 4px);
    border-radius: 4px;
    font-family: var(--outline-font-family);
    font-size: var(--outline-font-size, 13px);
    line-height: var(--outline-line-height, 1.5);
  }
  .row.auto .content { opacity: 0.92; }
  .tri { background: none; border: none; padding: 0; width: 1.1em; font-size: 0.7em;
    line-height: var(--outline-line-height, 1.5); cursor: pointer; opacity: 0.6; transition: transform 0.1s; }
  .tri.closed { transform: rotate(-90deg); }
  .tri-spacer { width: 1.1em; flex-shrink: 0; }
  .bullet { font-size: 1em; line-height: var(--outline-line-height, 1.5); opacity: 0.7; }
  .bullet.src-toc { color: var(--accent-color, #4a80d4); }
  .bullet.src-hl { color: #d4a94a; }
  .bullet.src-wl { color: #3aa99f; }
  .content { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; cursor: pointer;
    min-height: calc(1em * var(--outline-line-height, 1.5)); }
  .content:hover { text-decoration: underline dotted; text-underline-offset: 3px; }
</style>
```

- [ ] **Step 2: OutlinePanel.svelte 重写为只读预览**

保留:面板容器/splitter/宽度、typography probe、header(hide 按钮 + 标题)、搜索行、`ensureIndex`/`teardownIndex` 生命周期、`BacklinksSection`。
删除:全部编辑交互(band 框选、slash/link 菜单、NodeContextMenu、onGlobalKeydown、addRootNote、onBodyClick、applyToTextarea、regenerate、快捷键 resolved)、`外部冲突条`、对 `attachTab/detach/flushSave/scheduleSyncFromMain/markDirty/bump/pinnedIds/setSelection/clearSelection` 的所有引用。
header 的搜索/regenerate 按钮位置改为:搜索按钮保留,regenerate 换成"编辑"按钮。

新的数据流(`<script>` 核心,替换原 attach 相关 effects):

```ts
  import { companionPathFor } from '../../lib/outline/store.svelte'
  import { parseOutline } from '../../lib/outline/markdown'
  import { createTree, childrenOf, type OutlineTree, type OutlineNode as NodeT } from '../../lib/outline/model'
  import { ensureOutlineFile } from '../../lib/outline/create'
  import { tabs, openFile } from '../../lib/tabs.svelte'
  import { outlineAppliesTo } from '../../lib/outline/gate.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import ReadonlyNode from './ReadonlyNode.svelte'

  let { tab }: { tab: Tab | null } = $props()
  let applicable = $derived(tab != null && outlineAppliesTo(tab))
  let companionPath = $derived(applicable && tab ? companionPathFor(tab.filePath) : null)

  // 伴生文件已作为 tab 打开时镜像其实时内容(spec §4:以 tab 为准),否则读盘
  let mirrorTab = $derived(companionPath ? tabs.find(t => t.filePath === companionPath) ?? null : null)
  let diskText = $state<string | null>(null)
  let tree = $derived<OutlineTree>(
    mirrorTab ? parseOutline(mirrorTab.currentContent)
    : diskText != null ? parseOutline(diskText)
    : createTree())
  let collapsed = new SvelteSet<string>()

  // 读盘 + watch:仅在无镜像 tab 时生效
  $effect(() => {
    const path = companionPath
    if (!path || mirrorTab) { diskText = null; return }
    let alive = true
    let unwatch: (() => void) | null = null
    void (async () => {
      const { exists, readTextFile, watchImmediate } = await import('@tauri-apps/plugin-fs')
      const load = async () => {
        const text = (await exists(path).catch(() => false))
          ? await readTextFile(path).catch(() => null) : null
        if (alive) diskText = text
      }
      await load()
      if (!alive) return
      let timer: ReturnType<typeof setTimeout> | null = null
      watchImmediate(path, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { void load() }, 200)
      }).then(s => { if (alive) unwatch = s; else s() }).catch(() => {})
    })()
    return () => { alive = false; if (unwatch) { try { unwatch() } catch { /* ignore */ } } }
  })

  let roots = $derived(childrenOf(tree, null))

  async function openNoteTab() {
    if (!companionPath) return
    await ensureOutlineFile(companionPath)
    await openFile(companionPath)
  }
  function onNodeClick(_n: NodeT) { void openNoteTab() }   // spec §4:点击节点跳转大纲 tab
  function onPageClick(target: string) { void openPageOrCreate(target) }
```

搜索逻辑保留但改在本地 `tree` 上过滤(把原 `visibleIds` 的 `outline.tree.nodes` 换成 `tree.nodes`,`void outline.version` 删掉);`visibleRoots` 过滤同理。渲染主体:

```svelte
  {#if !applicable}
    <div class="body"><p class="empty">{tab == null ? t('outline.noDocument') : t('outline.notApplicable')}</p></div>
  {:else}
    <div class="body" role="tree">
      {#each visibleRoots as node (node.id)}
        <ReadonlyNode {node} depth={0} {tree} {collapsed} {onNodeClick} {onPageClick} />
      {/each}
      {#if visibleRoots.length === 0}
        <p class="empty">{visibleIds ? t('outline.noSearchResults') : t('outline.empty')}</p>
      {/if}
    </div>
    {#if !visibleIds}<BacklinksSection page={tab ? pageNameOf(tab.filePath) : null} excludeFile={companionPath} />{/if}
  {/if}
```

header 编辑按钮(替换原 regenerate 按钮,铅笔线条图标同风格):

```svelte
    <button class="hbtn" title={t('outline.editNote')} aria-label={t('outline.editNote')} disabled={!companionPath} onclick={() => void openNoteTab()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      </svg>
    </button>
```

`ensureIndex` effect 保留:`$effect(() => { if (applicable && outlineGate.visible && tab) void ensureIndex(tab.filePath) })`;unmount 兜底 effect 只留 `teardownIndex()`。

- [ ] **Step 3: BacklinksSection prop 化**

```ts
  let { page = null, excludeFile = null }: { page?: string | null; excludeFile?: string | null } = $props()
  let hits = $derived.by(() => {
    void outline.version
    if (!page || !outline.backlinkIndex) return []
    return backlinksFor(outline.backlinkIndex, page).filter(h => h.file !== excludeFile)
  })
```

(删除 `currentPageName`/`outline.companionPath` 引用;`outline`/`backlinksFor` import 保留。)

- [ ] **Step 4: backlinks-io 适配** — `openPageOrCreate` 的 `outline.mainPath` 改 `outline.docPath`;`currentPageName()` 改为 `outline.docPath ? pageNameOf(outline.docPath) : null`(编辑器 tab 模式下的自页名)。

- [ ] **Step 5: store 删除旧 IO 管线** — `store.svelte.ts` 删除:`attachTab`、`scheduleSyncFromMain`、`flushSave`、`onCompanionExternalChange`、`resolveConflictKeepMine`、`resolveConflictReload`、`ourLastWrite`、`attachSeq`、`saveTimer`/`syncTimer` 及 `markDirty` 的旧 debounce 通道(`markDirty` 只剩 `changeSink?.()`)、字段 `mainPath`/`companionPath`/`dirty`/`externalConflict`(`companionPathFor`、`persistIdsFor`、`isEffectivelyEmpty`、`pinnedIds`、`regenerate` 保留;`regenerate` 里 `markDirty()` 调用保留)。`detach()` 相应精简(清 docPath/树/选区)。同步清理 `store.test.ts` 中若有对已删导出的引用(现有测试只测 companionPathFor/persistIdsFor/isEffectivelyEmpty/attachDoc 组,应无需改动;有则删对应用例)。
`migrate.ts` 的 `attachTab` 集成点已随 attachTab 删除——把一期加在 attachTab 里的 `migrateLegacyCompanion` 调用移到 `tabs.svelte.ts` 的 `openFile`:在 `classifyPath` 成功、读文件**之前**插入:

```ts
  if (cls.kind === 'markdown' && !/\.notes?\.md$/i.test(path)) {
    const { migrateLegacyCompanion } = await import('./outline/migrate')
    await migrateLegacyCompanion(path).catch(() => {})
  }
```

(打开主文档时迁移其旧伴生文件,语义与一期一致且不再依赖面板挂载。)

- [ ] **Step 6: i18n** — en:`'outline.editNote': 'Edit note'`;zh:`'outline.editNote': '编辑笔记'`;ja:`'outline.editNote': 'ノートを編集'`。

- [ ] **Step 7:** `pnpm check` → 0 errors;`pnpm test` → 全过

- [ ] **Step 8: Commit**

```bash
git add -A src/components/outline src/lib/outline src/lib/tabs.svelte.ts src/lib/i18n
git commit -m "feat(outline): read-only companion panel — local tree, jump/edit entry; drop store file-IO pipeline"
```

---

### Task 4: OutlineEditor 全屏编辑器 + EditorPane 接线

**Files:**
- Create: `src/components/outline/OutlineEditor.svelte`
- Modify: `src/components/EditorPane.svelte`
- Test: `pnpm check` + 现有测试(交互走 Task 6 实机验证)

- [ ] **Step 1: OutlineEditor.svelte**

编辑交互整体来自旧版 OutlinePanel(git 历史 `git show HEAD~1:src/components/outline/OutlinePanel.svelte` 可查),以下为完整骨架与迁移清单;迁移块内除注明的替换外**逐字保留**:

```svelte
<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import { tabs, setContent, openFile } from '../../lib/tabs.svelte'
  import { outlineShortcuts } from '../../lib/outline/gate.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import OutlineNode from './OutlineNode.svelte'
  import SlashMenu from './SlashMenu.svelte'
  import LinkAutocomplete from './LinkAutocomplete.svelte'
  import NodeContextMenu from './NodeContextMenu.svelte'
  import BacklinksSection from './BacklinksSection.svelte'
  import {
    outline, attachDoc, detach, serializeDoc, setChangeSink, regenerate,
    bump, markDirty, pinnedIds, setSelection, clearSelection,
  } from '../../lib/outline/store.svelte'
  import { childrenOf, newId, calculateOrderBetween, setNodeContent, type OutlineNode as NodeT } from '../../lib/outline/model'
  import {
    moveNodeAfter, moveNodeToChild, deleteNode, subtreeToMarkdown,
    deleteNodes, indentNodes, outdentNodes, moveNodesAfter, moveNodesToChild, nodesToMarkdown,
  } from '../../lib/outline/commands'
  import { selectionRoots, rangeBetween } from '../../lib/outline/select'
  import { resolveShortcuts, type OutlineCommandId } from '../../lib/outline/shortcuts'
  import { filterSlashItems, applySlashItem, pageLinkQueryAt, confirmPageLink, filterPages, type SlashItem } from '../../lib/outline/completion'
  import { pageCandidates, pageNameOf } from '../../lib/outline/backlinks'
  import { activeTheme } from '../../lib/active-theme.svelte'
  import { requestReveal } from '../../lib/outline/reveal.svelte'
  import { ensureIndex, teardownIndex, openPageOrCreate } from '../../lib/outline/backlinks-io.svelte'
  import { untrack } from 'svelte'

  let { tab }: { tab: Tab } = $props()

  /** 伴生笔记的主文档路径;独立笔记(无同名 .md)为 null */
  let mainPath = $derived(tab.filePath.replace(/\.notes?\.md$/i, '.md'))
  let resolved = $derived(resolveShortcuts(outlineShortcuts.overrides))

  // 挂载:解析 tab 文本 → (伴生)派生同步 → 注册 sink。若派生/补 fm 改变了
  // 序列化结果,回写 tab 让脏标记如实反映。
  $effect(() => {
    const id = tab.id
    const path = tab.filePath
    untrack(() => {
      void (async () => {
        let mainContent: string | null = null
        const mainTab = tabs.find(x => x.filePath === mainPath)
        if (mainTab) mainContent = mainTab.currentContent
        else {
          const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
          if (await exists(mainPath).catch(() => false)) {
            mainContent = await readTextFile(mainPath).catch(() => null)
          }
        }
        await attachDoc(path, tab.currentContent, mainContent)
        const out = serializeDoc()
        if (out !== tab.currentContent) setContent(id, out)
        setChangeSink(() => setContent(id, serializeDoc()))
      })()
    })
    return () => untrack(() => { setChangeSink(null); detach() })
  })

  // 外部变更自动重载(干净 tab)→ 重新解析
  $effect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tabId: string; newContent: string } | undefined
      if (!detail || detail.tabId !== tab.id) return
      untrack(() => { void attachDoc(tab.filePath, detail.newContent, null) })
    }
    window.addEventListener('mdeditor:auto-reloaded', handler)
    return () => window.removeEventListener('mdeditor:auto-reloaded', handler)
  })

  $effect(() => { void ensureIndex(tab.filePath); return () => teardownIndex() })

  // 跳转:伴生笔记的 auto 节点 → 打开主文档并 reveal 行号
  async function onJump(n: NodeT) {
    if (n.anchorLine == null) return
    await openFile(mainPath).catch(() => {})
    requestReveal(n.anchorLine, n.content)
  }
  function onPageClick(target: string) { void openPageOrCreate(target) }
</script>
```

以下块从旧 OutlinePanel **原样迁移**(标注的标识符替换):
- typography probe(activeThemeId/probeEl/typo + effect)
- `roots`/搜索(searchOpen/searchQuery/visibleIds/visibleRoots/toggleSearch/onSearchKeydown)
- `onDragOp`、`addRootNote`、`onBodyClick`、默认可编辑 effect(空树建根节点)
- 多选整节(bodyEl/band/bandStart/... onBandDown/onBandMove/onBandUp、onGlobalKeydown)——其中 `applicable` 引用全部删掉(编辑器恒 applicable)
- 菜单整节(MenuState/menu/slashItems/linkPages/menuAnchor/applyToTextarea/onEditorInput/pickSlash/pickPage)+ 菜单关闭 effect
- `onRegenerate`:主文档内容改为 `tabs.find(x => x.filePath === mainPath)?.currentContent`,取不到时 `readTextFile(mainPath)`,均无则直接 return
- ctxMenu/onContextMenu/onCtxAction(`copy-ref` 分支的 `markDirty()` 保留)

模板(全屏布局,替换旧 aside):

```svelte
<div class="outline-editor" oncontextmenu={(e) => e.preventDefault()}
  style="--outline-font-family: {typo.family}; --outline-font-size: {typo.size}; --outline-line-height: {typo.line};{typo.fg ? ` color: ${typo.fg};` : ''}{typo.bg ? ` background: ${typo.bg};` : ''}">
  <div class="typo-probe" data-theme={activeThemeId} aria-hidden="true" bind:this={probeEl}>
    <div class="moraya-editor"></div>
  </div>
  <div class="toolbar">
    <span class="doc-title">{pageNameOf(tab.filePath)}</span>
    <button class="hbtn" class:on={searchOpen} title={t('outline.search')} onclick={toggleSearch}>(搜索 svg 同旧版)</button>
    <button class="hbtn" title={t('outline.regenerate')} onclick={onRegenerate}>(regenerate svg 同旧版)</button>
  </div>
  {#if searchOpen}(搜索行,同旧版){/if}
  <div class="body" role="tree" bind:this={bodyEl} onclick={onBodyClick}
    onpointerdown={onBandDown} onpointermove={onBandMove} onpointerup={onBandUp}>
    {#each visibleRoots as node (node.id)}
      <OutlineNode {node} depth={0} {resolved} {onJump} {onPageClick} {onEditorInput} {onContextMenu} {onDragOp} {visibleIds} />
    {/each}
    {#if visibleRoots.length === 0}<p class="empty">{visibleIds ? t('outline.noSearchResults') : t('outline.empty')}</p>{/if}
  </div>
  {#if !visibleIds}<BacklinksSection page={pageNameOf(tab.filePath)} excludeFile={tab.filePath} />{/if}
  (slash/link/ctx 菜单与 band 矩形块同旧版)
</div>
<svelte:window onkeydown={onGlobalKeydown} />
```

样式:从旧版复制 `.hbtn/.search-row/.search-input/.band/.empty/.typo-probe` 等,容器改:

```css
  .outline-editor { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column;
    user-select: none; -webkit-user-select: none; }
  .outline-editor :global(textarea), .outline-editor :global(input) { user-select: text; -webkit-user-select: text; }
  .toolbar { display: flex; align-items: center; gap: 4px; padding: 6px 16px;
    border-bottom: 1px solid var(--border-color, #3333); }
  .doc-title { flex: 1; font-size: 13px; font-weight: 600; opacity: 0.75; }
  .body { flex: 1; overflow-y: auto; padding: 16px 24px; max-width: 860px; width: 100%;
    margin: 0 auto; box-sizing: border-box; font-family: var(--outline-font-family); }
```

- [ ] **Step 2: EditorPane 接线** — import `isOutlineNoteTab` from `../lib/outline/gate.svelte` 与 `OutlineEditor`;渲染链在 `tab.mode === 'source'` 分支**之后**、`html` 分支之前插入(source 模式保留原文编辑,spec §3):

```svelte
  {:else if isOutlineNoteTab(tab)}
    {#key tab.id}
      <OutlineEditor {tab} />
    {/key}
```

- [ ] **Step 3:** `pnpm check` → 0 errors;`pnpm test` → 全过

- [ ] **Step 4: Commit**

```bash
git add src/components/outline/OutlineEditor.svelte src/components/EditorPane.svelte
git commit -m "feat(outline): full-screen outline editor tab for .note.md (plugin-gated)"
```

---

### Task 5: FolderView 配对呈现(note 图标 + 伴生行合并 + 角标)

**Files:**
- Modify: `src/lib/folder-view.svelte.ts`
- Modify: `src/components/FolderTreeNode.svelte`
- Modify: `src/components/FolderView.svelte`(透传 onOpen 用于角标,若已满足则不动)
- Test: `src/lib/folder-view.test.ts`

- [ ] **Step 1: 写失败测试** — `folder-view.test.ts` 追加:

```ts
import { pairNoteEntries, type FolderEntry } from './folder-view.svelte'

function f(name: string, isDir = false): FolderEntry {
  return { name, path: `/r/${name}`, isDir, kind: isDir ? null : 'markdown' }
}

describe('pairNoteEntries', () => {
  it('hides companion .note.md and marks its main file', () => {
    const out = pairNoteEntries([f('a.md'), f('a.note.md'), f('b.md')])
    expect(out.map(e => e.name)).toEqual(['a.md', 'b.md'])
    const a = out.find(e => e.name === 'a.md')!
    expect(a.hasNote).toBe(true)
    expect(a.notePath).toBe('/r/a.note.md')
    expect(out.find(e => e.name === 'b.md')!.hasNote).toBeUndefined()
  })
  it('legacy .notes.md pairs too', () => {
    const out = pairNoteEntries([f('a.md'), f('a.notes.md')])
    expect(out.map(e => e.name)).toEqual(['a.md'])
    expect(out[0].notePath).toBe('/r/a.notes.md')
  })
  it('standalone .note.md stays with isOutlineNote flag', () => {
    const out = pairNoteEntries([f('wiki.note.md')])
    expect(out).toHaveLength(1)
    expect(out[0].isOutlineNote).toBe(true)
  })
  it('directories and non-md untouched', () => {
    const out = pairNoteEntries([f('sub', true), f('x.png')])
    expect(out).toHaveLength(2)
  })
})
```

- [ ] **Step 2:** `pnpm vitest run src/lib/folder-view.test.ts` → FAIL

- [ ] **Step 3: 实现** — `folder-view.svelte.ts`:

`FolderEntry` 增加可选字段:

```ts
export interface FolderEntry {
  name: string
  path: string
  isDir: boolean
  kind: FileKind | null // null = directory or unsupported file type
  /** 独立大纲笔记(.note.md 无同名主文档):专属 note 图标 */
  isOutlineNote?: boolean
  /** 同目录存在配对 xxx.note.md:行尾角标,点击打开笔记 */
  hasNote?: boolean
  notePath?: string
}
```

新增纯函数(spec §4.5;不随插件开关变化):

```ts
const NOTE_SUFFIX_RE = /\.notes?\.md$/i

/** 同目录配对:xxx.note.md 有同名 xxx.md → 隐藏该行并给主行打 hasNote;
 *  无主文档的 .note.md 保留行并标 isOutlineNote。 */
export function pairNoteEntries(entries: FolderEntry[]): FolderEntry[] {
  const names = new Set(entries.filter(e => !e.isDir).map(e => e.name.toLowerCase()))
  const noteFor = new Map<string, FolderEntry>() // 主文件名(小写) → 笔记 entry
  for (const e of entries) {
    if (e.isDir || !NOTE_SUFFIX_RE.test(e.name)) continue
    const mainName = e.name.replace(NOTE_SUFFIX_RE, '.md').toLowerCase()
    if (names.has(mainName)) noteFor.set(mainName, e)
  }
  const out: FolderEntry[] = []
  for (const e of entries) {
    if (!e.isDir && NOTE_SUFFIX_RE.test(e.name)) {
      const mainName = e.name.replace(NOTE_SUFFIX_RE, '.md').toLowerCase()
      if (names.has(mainName)) continue            // 伴生:行隐藏
      out.push({ ...e, isOutlineNote: true })       // 独立笔记
      continue
    }
    const note = !e.isDir ? noteFor.get(e.name.toLowerCase()) : undefined
    out.push(note ? { ...e, hasNote: true, notePath: note.path } : e)
  }
  return out
}
```

`readFolder` 中 `const sorted = sortEntries(entries)` 改为 `const sorted = sortEntries(pairNoteEntries(entries))`。

- [ ] **Step 4:** `pnpm vitest run src/lib/folder-view.test.ts` → PASS

- [ ] **Step 5: FolderTreeNode 图标与角标**

文件行图标分支改为(在现有 `{:else}` 文件分支内):

```svelte
    {#if entry.isOutlineNote}
      <svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="13" y2="17" />
      </svg>
    {:else}
      (原文件 svg 不动)
    {/if}
```

label 之后加角标(可点击,阻断行点击):

```svelte
  {#if entry.hasNote && entry.notePath}
    <span class="note-badge" role="button" tabindex="-1" title={t('folderView.openNote')}
      onclick={(e) => { e.stopPropagation(); onOpen(entry.notePath!) }}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <line x1="8" y1="13" x2="16" y2="13" />
      </svg>
    </span>
  {/if}
```

(顶部补 `import { t } from '../lib/i18n/store.svelte'`;style 加:)

```css
  .note-badge { flex: 0 0 auto; display: inline-flex; opacity: 0.5; padding: 1px; border-radius: 3px; }
  .note-badge:hover { opacity: 1; background: rgba(0,0,0,0.08); }
```

i18n:en `'folderView.openNote': 'Open note'`;zh `'folderView.openNote': '打开笔记'`;ja `'folderView.openNote': 'ノートを開く'`。

- [ ] **Step 6:** `pnpm check && pnpm test` → 全绿

- [ ] **Step 7: Commit**

```bash
git add src/lib/folder-view.svelte.ts src/lib/folder-view.test.ts src/components/FolderTreeNode.svelte src/lib/i18n
git commit -m "feat(folder-view): pair .note.md companions — hide row, badge on main file, note icon"
```

---

### Task 6: 全量回归 + dev 实机验证

- [ ] **Step 1:** `pnpm check && pnpm test` → 全绿

- [ ] **Step 2: dev 实机验证**(按 `reference_dev_gui_verification`;**先清场单实例**,验证期确保无并行会话干扰;fixtures 用 /tmp/nv2test)

1. 插件启用时打开 `wiki.note.md`(独立笔记)→ 全屏大纲编辑器;输入/缩进/回车建节点;Cmd+S 落盘,文件为 fm + `- ` 列表;tab 脏点随编辑出现、保存后消失
2. 切 source 模式 → 原文可编辑;改一行切回 rich → 大纲反映修改
3. 打开 `xxx.md`(有伴生笔记)→ 右侧面板只读显示;点节点/编辑按钮 → 打开大纲 tab;面板与 tab 同开时编辑 tab,面板实时镜像
4. 面板对无伴生文件的 `yyy.md` 点"编辑" → 创建 fm+空大纲的 `yyy.note.md` 并打开
5. 伴生笔记大纲 tab 挂载时对主文档跑派生(主文档有高亮/引用语法时 auto 节点出现);bullet 点击跳回主文档对应行
6. FolderView:`a.md`+`a.note.md` → 只显示 `a.md` 行+角标,点角标开笔记;独立 `wiki.note.md` 显示 note 图标;插件关闭后重启:呈现不变,角标点开进 markdown 编辑器
7. 插件关闭时打开 `.note.md` → 普通 markdown 编辑器(降级)
8. 外部改 `.note.md`(另一编辑器写入)→ tab 外部变更横幅正常;Reload 后大纲刷新

- [ ] **Step 3: 提交验证记录**(`git commit --allow-empty` 附验证清单结果)

---

## Self-Review 结果

- **Spec 覆盖:** §3 打开行为(Task 2 gate + Task 4 接线;source 模式原文编辑;降级=gate false 走 RichEditor)、序列化回 currentContent(Task 1 sink + Task 4)、store 单实例说明(架构节;活动 tab 独占,无需实例化)。§4 面板只读(Task 3)、编辑按钮/点击跳转(Task 3)、派生移到 tab 挂载(Task 1 attachDoc + Task 4)、镜像已开 tab(Task 3 mirrorTab)。§4.5 图标/合并/角标/角标可点/不随插件开关(Task 5,pairNoteEntries 无插件判断)。
- **偏离声明:** spec §3 "新 kind `outline`" 以渲染期 gate 实现(行为等价,插件开关即时生效);一期 attachTab 内的迁移钩子移至 `openFile`(语义不变)。
- **占位符:** 无 TBD/TODO;Task 4 的"原样迁移"块均指向仓库内现存代码并列明替换点。
- **类型一致性:** `attachDoc(path, text, mainContent)`/`serializeDoc()`/`setChangeSink(fn|null)` 贯穿 Task 1/3/4;`FolderEntry.hasNote/notePath/isOutlineNote` 贯穿 Task 5;`BacklinksSection {page, excludeFile}` 贯穿 Task 3/4。
