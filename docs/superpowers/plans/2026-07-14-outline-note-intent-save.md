# 伴生笔记「按意图保存」实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `.note.md` 只在用户表达写笔记意图时才创建/保存——同步只进内存+置脏，写盘由保存按钮或节点输入激活，并在 panel 模式写盘前做 hash 冲突校验。

**Architecture:** outline 单例 store 上新增 `dirty`/`armed`/`externalConflict` 三个 `$state`；拆 `markDirty`（用户编辑，arm+写）与 `markSynced`（同步，仅置脏，armed 后才写）；panel-disk 落盘点 `flushDisk` 接入纯函数 `decideCompanionWrite` 做写盘前 hash 校验；工具栏加保存按钮当脏指示器；铅笔改为惰性打开未保存 tab。

**Tech Stack:** Svelte 5 runes（`$state`/`$derived`/`$effect`）、Tauri plugin-fs、vitest、自研 i18n（en/zh/de/ja）、`sha256Hex`（`src/lib/hash.ts`）。

参考 spec：`docs/superpowers/specs/2026-07-14-outline-note-intent-save-design.md`

---

## 文件结构

- Modify `src/lib/outline/store.svelte.ts` — 新增 `dirty`/`armed`/`externalConflict` 状态、`markSynced`/`markSaved`、改 `markDirty`、`attachDoc`/`detach` 重置。
- Create `src/lib/outline/companion-write.ts` — 纯函数 `decideCompanionWrite`（写盘前冲突判定）。
- Create `src/lib/outline/companion-write.test.ts` — 上述纯函数测试。
- Modify `src/lib/outline/store.test.ts` — dirty/armed 门控测试。
- Modify `src/components/outline/OutlineEditor.svelte` — sync 用 `markSynced`；`flushDisk` 接冲突校验+`markSaved`+hash 种子；保存按钮；冲突横幅。
- Modify `src/components/outline/OutlinePanel.svelte` — 铅笔惰性打开。
- Modify `src/lib/tabs.svelte.ts` — 新增 `openNewOutlineTab`；`saveActive` 保存后补挂 watcher。
- Modify `src/lib/i18n/{en,zh,de,ja}.ts` — 新增 `outline.save`。

---

## Task 1: store —— dirty/armed 状态与 markSynced/markSaved

**Files:**
- Modify: `src/lib/outline/store.svelte.ts`
- Test: `src/lib/outline/store.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `store.test.ts` 末尾；顶部 import 补 `markSynced, markSaved`）

```ts
import { outline, companionPathFor, persistIdsFor, attachDoc, serializeDoc, setChangeSink, markDirty, markSynced, markSaved, detach, isEffectivelyEmptyTree, noteTextHasContent } from './store.svelte'

describe('dirty / armed 保存门控', () => {
  it('attachDoc: 有内容则 armed，空则不 armed，均非 dirty', async () => {
    await attachDoc('/v/a.note.md', '- hello\n', null)
    expect(outline.armed).toBe(true)
    expect(outline.dirty).toBe(false)
    await attachDoc('/v/b.note.md', '', null)
    expect(outline.armed).toBe(false)
    expect(outline.dirty).toBe(false)
    detach()
  })
  it('markSynced 只置 dirty；未 armed 不触发 sink，armed 后触发', async () => {
    await attachDoc('/v/c.note.md', '', null)   // armed=false
    let calls = 0
    setChangeSink(() => { calls++ })
    markSynced()
    expect(outline.dirty).toBe(true)
    expect(calls).toBe(0)
    markDirty()                                  // 用户编辑激活
    expect(outline.armed).toBe(true)
    expect(calls).toBe(1)
    markSynced()                                 // 已 armed → sink 触发
    expect(calls).toBe(2)
    setChangeSink(null)
    detach()
  })
  it('markSaved 清 dirty', async () => {
    await attachDoc('/v/d.note.md', '- x\n', null)
    markDirty()
    expect(outline.dirty).toBe(true)
    markSaved()
    expect(outline.dirty).toBe(false)
    detach()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/outline/store.test.ts`
Expected: FAIL —— `outline.armed`/`markSynced`/`markSaved` 未定义。

- [ ] **Step 3: 实现**

`OutlineState` 接口内新增字段：

```ts
  backlinkIndex: BacklinkIndex | null
  /** 相对上次落盘是否有未保存变更（驱动保存按钮指示态） */
  dirty: boolean
  /** 自动保存是否已激活（磁盘已有内容 / 用户编辑过 / 点过保存） */
  armed: boolean
  /** panel 模式写盘前发现远端已改动的冲突态；非 null 时禁止自动写盘 */
  externalConflict: { diskText: string } | null
```

`outline = $state<OutlineState>({...})` 初值追加：

```ts
  backlinkIndex: null,
  dirty: false,
  armed: false,
  externalConflict: null,
```

`attachDoc` 内，在末尾 `bump()` 之前追加（`text` 即笔记文本）：

```ts
  outline.armed = noteTextHasContent(text)
  outline.dirty = false
  outline.externalConflict = null
  if (mainContent != null) syncAutoItems(outline.tree, deriveAutoItems(mainContent))
  bump()
```

`detach` 内追加重置：

```ts
  outline.selectionAnchor = null
  outline.dirty = false
  outline.armed = false
  outline.externalConflict = null
  bump()
```

改写 `markDirty` 并新增两函数（替换文件末尾 `markDirty`）：

```ts
/** 用户编辑：置脏 + 激活自动保存 + 通知 sink 落盘。 */
export function markDirty(): void {
  outline.dirty = true
  outline.armed = true
  changeSink?.()
}

/** 同步派生：只置脏；仅在已激活时才落盘（浏览/主文档编辑不自动生成笔记）。 */
export function markSynced(): void {
  outline.dirty = true
  if (outline.armed) changeSink?.()
}

/** 落盘成功后清脏（写盘点回调）。 */
export function markSaved(): void {
  outline.dirty = false
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/outline/store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/outline/store.svelte.ts src/lib/outline/store.test.ts
git commit -m "feat(outline): dirty/armed state + markSynced/markSaved gating"
```

---

## Task 2: 纯函数 decideCompanionWrite —— 写盘前冲突判定

**Files:**
- Create: `src/lib/outline/companion-write.ts`
- Test: `src/lib/outline/companion-write.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/outline/companion-write.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { decideCompanionWrite } from './companion-write'

describe('decideCompanionWrite', () => {
  it('无文件 → write（创建）', () => {
    expect(decideCompanionWrite({ fileExists: false, diskHash: null, lastHash: null, ourHash: 'a' })).toBe('write')
  })
  it('磁盘已等于我们要写的内容 → noop', () => {
    expect(decideCompanionWrite({ fileExists: true, diskHash: 'a', lastHash: 'x', ourHash: 'a' })).toBe('noop')
  })
  it('自加载以来磁盘未变 → write', () => {
    expect(decideCompanionWrite({ fileExists: true, diskHash: 'x', lastHash: 'x', ourHash: 'b' })).toBe('write')
  })
  it('磁盘在我们不知情时被改 → conflict', () => {
    expect(decideCompanionWrite({ fileExists: true, diskHash: 'y', lastHash: 'x', ourHash: 'b' })).toBe('conflict')
  })
  it('出现一个我们不知道的文件（lastHash 为 null） → conflict', () => {
    expect(decideCompanionWrite({ fileExists: true, diskHash: 'y', lastHash: null, ourHash: 'b' })).toBe('conflict')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/outline/companion-write.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`src/lib/outline/companion-write.ts`：

```ts
// src/lib/outline/companion-write.ts
export type CompanionWriteDecision = 'write' | 'noop' | 'conflict'

/**
 * panel 模式 .note.md 写盘前的冲突判定（写盘前 hash 校验，不引入文件监听）。
 * - fileExists=false                          → 'write'（磁盘无文件，创建）
 * - diskHash === ourHash                       → 'noop'（磁盘已等于我们要写的内容）
 * - lastHash != null && diskHash === lastHash  → 'write'（自加载/上次写入以来磁盘没变）
 * - 否则                                       → 'conflict'（远端在我们不知情时改/建了文件）
 */
export function decideCompanionWrite(args: {
  fileExists: boolean
  diskHash: string | null
  lastHash: string | null
  ourHash: string
}): CompanionWriteDecision {
  if (!args.fileExists) return 'write'
  if (args.diskHash === args.ourHash) return 'noop'
  if (args.lastHash != null && args.diskHash === args.lastHash) return 'write'
  return 'conflict'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/outline/companion-write.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/outline/companion-write.ts src/lib/outline/companion-write.test.ts
git commit -m "feat(outline): pure decideCompanionWrite conflict guard"
```

---

## Task 3: OutlineEditor —— sync 用 markSynced + flushDisk 冲突校验

**Files:**
- Modify: `src/components/outline/OutlineEditor.svelte`

无独立单元测试（组件+Tauri 依赖），靠 Task 8 手动验证。

- [ ] **Step 1: 补 import**

顶部 store import 里加 `markSynced, markSaved`，并新增两行 import：

```ts
  import {
    outline, attachDoc, detach, serializeDoc, setChangeSink, regenerate,
    bump, markDirty, markSynced, markSaved, pinnedIds, setSelection, clearSelection, companionPathFor,
    isEffectivelyEmptyTree, noteTextHasContent,
  } from '../../lib/outline/store.svelte'
  import { sha256Hex } from '../../lib/hash'
  import { decideCompanionWrite } from '../../lib/outline/companion-write'
```

- [ ] **Step 2: 新增 flushDisk 用的 hash 种子变量**

在 `let diskPending: string | null = null` 附近新增：

```ts
  let diskPending: string | null = null
  /** 冲突校验基线：我们上次加载/写入 .note.md 时的 sha256（null=当时磁盘无此文件） */
  let noteDiskHash: string | null = null
```

- [ ] **Step 3: 改写 flushDisk 接入冲突校验**

用下面整体替换现有 `flushDisk` 函数（line 50-69）：

```ts
  async function flushDisk() {
    if (diskTimer) { clearTimeout(diskTimer); diskTimer = null }
    const text = diskPending
    diskPending = null
    if (text == null) return
    if (outline.externalConflict) return               // 冲突未解决前不写
    try {
      const fs = await import('@tauri-apps/plugin-fs')
      const existed = await fs.exists(notePath).catch(() => false)
      if (text.trim() === '' && !existed) return       // 空大纲 + 无文件 → 不创建
      // Data-loss guard（保留）：别用空白序列化盖掉有内容的现存笔记
      if (!noteTextHasContent(text) && existed) {
        const existing = await fs.readTextFile(notePath).catch(() => '')
        if (noteTextHasContent(existing)) return
      }
      const diskText = existed ? await fs.readTextFile(notePath).catch(() => null) : null
      const diskHash = diskText != null ? await sha256Hex(diskText) : null
      const ourHash = await sha256Hex(text)
      const decision = decideCompanionWrite({
        fileExists: diskText != null, diskHash, lastHash: noteDiskHash, ourHash,
      })
      if (decision === 'conflict') { outline.externalConflict = { diskText: diskText ?? '' }; return }
      if (decision === 'noop') { noteDiskHash = diskHash; markSaved(); return }
      await fs.writeTextFile(notePath, text)
      noteDiskHash = ourHash
      markSaved()
    } catch (e) {
      console.warn('[outline] write companion failed:', e)
    }
  }
```

- [ ] **Step 4: 挂载 effect —— 去掉 mount 自动写盘、种下 noteDiskHash**

在挂载 `$effect` 的 `else`（panel-disk）分支（现 line 127-132）里，用下面替换（删除原 line 128 的 mount 时 `persistToDisk`，改为种 hash）：

```ts
        } else {
          // panel-disk：种下冲突校验基线；不在挂载时自动写盘（避免“打开即写”）
          const fsMod = await import('@tauri-apps/plugin-fs')
          const existed0 = await fsMod.exists(path).catch(() => false)
          if (cancelled) return
          noteDiskHash = existed0
            ? await sha256Hex(await fsMod.readTextFile(path).catch(() => '')).catch(() => null)
            : null
          if (cancelled) return
          setChangeSink(() => { if (outline.docPath === path) persistToDisk(serializeDoc()) })
        }
```

- [ ] **Step 5: sync effect 改用 markSynced**

同步 `$effect`（现 line 157）里把 `markDirty()` 换成 `markSynced()`：

```ts
        if (serializeDoc(false) !== before) { bump(); markSynced() }
```

- [ ] **Step 6: check 通过**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -A2 OutlineEditor || echo "no OutlineEditor errors"`
Expected: 无 OutlineEditor.svelte 相关 error。

- [ ] **Step 7: 提交**

```bash
git add src/components/outline/OutlineEditor.svelte
git commit -m "feat(outline): panel sync marks synced (no autosave) + write-time conflict guard"
```

---

## Task 4: 工具栏保存按钮 + i18n

**Files:**
- Modify: `src/components/outline/OutlineEditor.svelte`
- Modify: `src/lib/i18n/{en,zh,de,ja}.ts`
- Modify: `src/lib/tabs.svelte.ts`（新增 `saveTab`）

- [ ] **Step 1: i18n 新增 outline.save（四语言）**

`src/lib/i18n/en.ts`（`'outline.editNote'` 行后）：

```ts
  'outline.save': 'Save note',
```

`src/lib/i18n/zh.ts`：

```ts
  'outline.save': '保存笔记',
```

`src/lib/i18n/de.ts`：

```ts
  'outline.save': 'Notiz speichern',
```

`src/lib/i18n/ja.ts`：

```ts
  'outline.save': 'ノートを保存',
```

- [ ] **Step 2: tabs 新增 saveTab（按 id 保存，不切换 active）**

`src/lib/tabs.svelte.ts` 内 `saveActive` 之后新增（复用已有本地 `recordOurWrite`、`writeMd`）：

```ts
/** 按 id 保存指定 tab（不改变 active）；供大纲工具栏保存按钮在笔记以 tab 打开时调用。 */
export async function saveTab(id: string): Promise<void> {
  const t = tabs.find((x) => x.id === id)
  if (!t || !t.filePath) return
  if (t.externalState === 'changed') {
    throw new Error(`"${t.title}" was modified externally. Use the banner to Reload, Overwrite, or Save as…`)
  }
  await writeMd(t.filePath, t.currentContent)
  t.initialContent = t.currentContent
  await recordOurWrite(t)
}
```

- [ ] **Step 3: OutlineEditor 加保存按钮的派生态与处理器**

`OutlineEditor.svelte` `<script>` 内（`onRegenerate` 附近）新增：

```ts
  // 保存按钮脏态：笔记以 tab 打开 → 跟随 tab 脏；否则跟随 panel-disk 的 outline.dirty
  let saveDirty = $derived(noteTab ? noteTab.currentContent !== noteTab.initialContent : outline.dirty)
  async function onSave() {
    if (noteTab) {
      const { saveTab } = await import('../../lib/tabs.svelte')
      await saveTab(noteTab.id)
    } else {
      await flushDisk()
    }
  }
```

- [ ] **Step 4: 工具栏加按钮**

`OutlineEditor.svelte` 模板里，重新生成按钮（`onclick={onRegenerate}`）那个 `</button>` 之后新增：

```svelte
    <button class="hbtn" class:dirty={saveDirty} title={t('outline.save')} aria-label={t('outline.save')} disabled={!saveDirty} onclick={() => void onSave()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
        <polyline points="17 21 17 13 7 13 7 21" />
        <polyline points="7 3 7 8 15 8" />
      </svg>
    </button>
```

- [ ] **Step 5: 保存按钮脏态样式**

`OutlineEditor.svelte` `<style>` 里 `.hbtn.on {...}` 附近新增：

```css
  .hbtn.dirty { position: relative; color: var(--accent-color, #4a80d4); opacity: 1; }
  .hbtn.dirty::after {
    content: ''; position: absolute; top: 1px; right: 1px;
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--accent-color, #4a80d4);
  }
```

- [ ] **Step 6: check 通过**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -E "OutlineEditor|tabs\.svelte|i18n" || echo "clean"`
Expected: `clean`（无相关 error）。

- [ ] **Step 7: 提交**

```bash
git add src/components/outline/OutlineEditor.svelte src/lib/tabs.svelte.ts src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/de.ts src/lib/i18n/ja.ts
git commit -m "feat(outline): toolbar save button as dirty indicator (+ saveTab, i18n)"
```

---

## Task 5: 冲突横幅

**Files:**
- Modify: `src/components/outline/OutlineEditor.svelte`

复用现有 i18n：`outline.externalChanged`、`externalChange.reload`、`externalChange.overwrite`（四语言均已存在，无需新增）。

- [ ] **Step 1: 加冲突处理器**

`OutlineEditor.svelte` `<script>` 内（`onSave` 附近）新增：

```ts
  async function reloadRemote() {
    const diskText = outline.externalConflict?.diskText ?? ''
    outline.externalConflict = null
    noteDiskHash = await sha256Hex(diskText).catch(() => null)
    const mc = mainTab ? mainTab.currentContent
      : tabs.find(x => x.filePath === mainPath)?.currentContent ?? null
    await attachDoc(notePath, diskText, mc)   // 重置 dirty=false、armed 随内容
  }
  async function overwriteLocal() {
    outline.externalConflict = null
    const text = serializeDoc()
    const fs = await import('@tauri-apps/plugin-fs')
    await fs.writeTextFile(notePath, text)
    noteDiskHash = await sha256Hex(text).catch(() => null)
    outline.armed = true
    markSaved()
  }
```

- [ ] **Step 2: 加横幅模板**

`OutlineEditor.svelte` 模板里，工具栏 `</div>`（`.toolbar` 收尾）之后、`{#if searchOpen}` 之前新增：

```svelte
  {#if outline.externalConflict}
    <div class="conflict-banner" role="alert">
      <span class="conflict-msg">{t('outline.externalChanged')}</span>
      <button class="conflict-btn" onclick={() => void reloadRemote()}>{t('externalChange.reload')}</button>
      <button class="conflict-btn" onclick={() => void overwriteLocal()}>{t('externalChange.overwrite')}</button>
    </div>
  {/if}
```

- [ ] **Step 3: 横幅样式**

`OutlineEditor.svelte` `<style>` 里新增：

```css
  .conflict-banner {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 6px 16px; font-size: 12px;
    background: color-mix(in srgb, #e0a030 18%, transparent);
    border-bottom: 1px solid color-mix(in srgb, #e0a030 40%, transparent);
  }
  .conflict-msg { flex: 1; min-width: 0; opacity: 0.9; }
  .conflict-btn {
    border: 1px solid var(--border-color, #3335); background: transparent;
    color: inherit; cursor: pointer; padding: 2px 8px; border-radius: 4px; font-size: 12px;
  }
  .conflict-btn:hover { background: rgba(0,0,0,0.08); }
  @media (prefers-color-scheme: dark) {
    .conflict-btn:hover { background: rgba(255,255,255,0.1); }
  }
```

- [ ] **Step 4: check 通过**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep OutlineEditor || echo "clean"`
Expected: `clean`

- [ ] **Step 5: 提交**

```bash
git add src/components/outline/OutlineEditor.svelte
git commit -m "feat(outline): panel-mode conflict banner (reload/overwrite)"
```

---

## Task 6: 铅笔惰性打开未保存 tab

**Files:**
- Modify: `src/lib/tabs.svelte.ts`（新增 `openNewOutlineTab` + `saveActive` 补挂 watcher）
- Modify: `src/components/outline/OutlinePanel.svelte`

- [ ] **Step 1: tabs 新增 openNewOutlineTab**

`src/lib/tabs.svelte.ts` 内 `newFile()` 之后新增（`basename`/`startWatchingTab`/`notifyInsights` 均已在文件内可用）：

```ts
/**
 * 打开一个绑定到 `path`、但磁盘上尚无文件的未保存大纲 tab（惰性创建）。
 * initialContent='' 故 tab 天然 dirty；首次 ⌘S/保存按钮才 writeMd 落盘。
 * 文件此刻不存在，startWatchingTab 会静默降级（focus-poll 兜底），保存后补挂。
 */
export async function openNewOutlineTab(path: string, content: string): Promise<void> {
  const existing = tabs.find((t) => t.filePath === path)
  if (existing) { activeId.value = existing.id; notifyInsights('onActiveDocChanged'); return }
  const tab: Tab = {
    id: crypto.randomUUID(),
    filePath: path,
    title: basename(path),
    initialContent: '',
    currentContent: content,
    mode: 'rich',
    kind: 'markdown',
    language: undefined,
    externalState: 'fresh',
    externalBannerDismissed: false,
    lastKnownMtime: 0,
    lastKnownHash: '',
    pendingExternal: undefined,
  }
  tabs.push(tab)
  activeId.value = tab.id
  notifyInsights('onActiveDocChanged')
  await startWatchingTab(tab).catch(() => {})
}
```

- [ ] **Step 2: saveActive 保存后补挂 watcher**

`src/lib/tabs.svelte.ts` `saveActive()` 内，写盘成功（`recordOurWrite` 调用）之后加一行（幂等，已订阅则 no-op；修复惰性 tab 首存后的推送监听）：

```ts
  await writeMd(t.filePath, t.currentContent)
  t.initialContent = t.currentContent
  await recordOurWrite(t)
  await startWatchingTab(t)
```

> 注：若 `saveActive` 现有写盘顺序不同，把 `await startWatchingTab(t)` 加在该函数最后一次成功写盘之后即可。`startWatchingTab` 已 import（同文件）。

- [ ] **Step 3: OutlinePanel 铅笔惰性打开**

`src/components/outline/OutlinePanel.svelte`：删除 `import { ensureOutlineFile } from '../../lib/outline/create'`，改写 `openNoteTab`：

```ts
  async function openNoteTab() {
    if (!companionPath) return
    const { exists } = await import('@tauri-apps/plugin-fs')
    if (await exists(companionPath).catch(() => false)) {
      await openFile(companionPath)
      return
    }
    const [{ openNewOutlineTab }, { pageNameOf }, { newOutlineFileText }] = await Promise.all([
      import('../../lib/tabs.svelte'),
      import('../../lib/outline/backlinks'),
      import('../../lib/outline/create'),
    ])
    await openNewOutlineTab(companionPath, newOutlineFileText(pageNameOf(companionPath)))
  }
```

- [ ] **Step 4: check 通过**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -E "OutlinePanel|tabs\.svelte" || echo "clean"`
Expected: `clean`

- [ ] **Step 5: 提交**

```bash
git add src/lib/tabs.svelte.ts src/components/outline/OutlinePanel.svelte
git commit -m "feat(outline): lazy-open unsaved note tab (no empty-file precreate)"
```

---

## Task 7: 全量 check + test

- [ ] **Step 1: 全量单元测试**

Run: `pnpm test`
Expected: 全绿（含新增 store/companion-write 测试）。

- [ ] **Step 2: 类型检查**

Run: `pnpm check`
Expected: 0 error（既有 warning 不新增）。

- [ ] **Step 3: 如有失败按 systematic-debugging 修复后重跑**

---

## Task 8: dev GUI 实机验证（人工）

遵循 [[feedback_no_ui_automation_user_tests]]：只起 dev 构建 + 给手动步骤，不做桌面自动化。moraya-core 未改动，无需 tsup/sync。

- [ ] **Step 1: 起 dev**

Run: `pnpm tauri dev`（或项目既有 dev 命令）

- [ ] **Step 2: 逐条验收（对照 spec §测试）**

1. 开右侧大纲面板，浏览一个含标题/高亮的 `.md`、不触碰面板 → 目录里**不出现** `.note.md`。
2. 编辑主文档 → 面板同步显示派生条目、保存按钮**变亮带小圆点**、磁盘仍无文件。
3. 点保存按钮 → `.note.md` 出现、按钮变灰禁用。
4. 在任意节点打字 → 自动保存生效、文件随之更新。
5. 已有内容的笔记：只编辑主文档（不打字）→ 照常自动保存。
6. 冲突：面板有未保存编辑时，用外部编辑器改写同名 `.note.md` → 下次自动/手动写盘被拦、弹冲突横幅；点“重载”取远端、点“覆盖”取本地，各自正确。
7. 铅笔：对无笔记的文档点铅笔 → 打开未保存大纲 tab、目录里仍无文件；⌘S 后文件出现。

- [ ] **Step 3: 通过后按需发布**

参照 [[feedback_auto_release]]：GUI 改动须先 dev 实机验证（本任务），通过后再走发布流程。

---

## Self-Review 记录

- **Spec 覆盖**：默认不自动生成→Task 3 Step 4/5 + Task 6；同步进内存不保存→Task 1(markSynced)+Task 3;保存按钮两确认→Task 1(markDirty arm)+Task 4;按钮指示态→Task 4;写盘前冲突校验→Task 2+Task 3+Task 5;惰性创建→Task 6。全覆盖。
- **占位符**：无 TBD/TODO；每个改动步骤都给了完整代码。
- **类型一致**：`decideCompanionWrite` 参数/返回在 Task 2 定义、Task 3 调用一致；`markSynced`/`markSaved`/`saveTab`/`openNewOutlineTab` 定义与调用签名一致；`outline.externalConflict` 形状 `{ diskText: string } | null` 全程一致。
- **风险**：惰性 tab 首存前无推送监听（focus-poll 兜底），Task 6 Step 2 补挂缓解；`$effect` 内新增 await 已加 `cancelled` 守卫（Task 3 Step 4）；`markSynced`/`markDirty` 只读写 store 的 `$state`，不在 effect 内自读自写触发死循环（[[feedback_svelte_effect_untrack]] 场景不适用，因这些函数由事件/防抖回调触发，非 effect 同步体内）。
