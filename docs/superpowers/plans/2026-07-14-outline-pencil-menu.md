# 大纲面板铅笔菜单 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 大纲面板右上角铅笔点击改为弹菜单：「使用 Markdown 打开」（source 模式）和「删除」（确认后删盘+关 tab+面板重置，无文件禁用）。

**Architecture:** 纯组件改动——`OutlinePanel.svelte` 加 fixed 定位小菜单 + 两个处理器；「打开」用 `setMode(id,'source')` 借 EditorPane 路由优先级绕过大纲；「删除」用 `closeTab`+`plugin-fs.remove`，并用 `{#key}` 里的 `resetTick` 强制 OutlineEditor 重挂重读。

**Tech Stack:** Svelte 5 runes、Tauri plugin-fs(exists/remove)、plugin-dialog(ask)、i18n(en/zh/de/ja)。

参考 spec：`docs/superpowers/specs/2026-07-14-outline-pencil-menu-design.md`

---

## 文件结构

- Modify `src/lib/i18n/{en,zh,de,ja}.ts` — `outline.openMarkdown`/`outline.deleteNote`/`outline.deleteNoteConfirm`。
- Modify `src/components/outline/OutlinePanel.svelte` — 铅笔改菜单触发；菜单 + 处理器 + 状态 + `{#key}` 加 resetTick。

无纯逻辑单测（组件+dialog+fs）；靠 Task 3 dev GUI 验证。

---

## Task 1: i18n 三键 × 四语言

**Files:** Modify `src/lib/i18n/en.ts`、`zh.ts`、`de.ts`、`ja.ts`

- [ ] **Step 1: en.ts**（`'outline.editNote'` 行后）

```ts
  'outline.openMarkdown': 'Open as Markdown',
  'outline.deleteNote': 'Delete note',
  'outline.deleteNoteConfirm': 'Delete this sidecar note file? This cannot be undone.',
```

- [ ] **Step 2: zh.ts**（`'outline.editNote'` 行后）

```ts
  'outline.openMarkdown': '使用 Markdown 打开',
  'outline.deleteNote': '删除笔记',
  'outline.deleteNoteConfirm': '删除这份伴生笔记文件？此操作不可撤销。',
```

- [ ] **Step 3: de.ts**（`'outline.editNote'` 行后）

```ts
  'outline.openMarkdown': 'Als Markdown öffnen',
  'outline.deleteNote': 'Notiz löschen',
  'outline.deleteNoteConfirm': 'Diese Begleitnotiz löschen? Kann nicht rückgängig gemacht werden.',
```

- [ ] **Step 4: ja.ts**（`'outline.editNote'` 行后）

```ts
  'outline.openMarkdown': 'Markdown で開く',
  'outline.deleteNote': 'ノートを削除',
  'outline.deleteNoteConfirm': 'この伴走ノートを削除しますか？元に戻せません。',
```

- [ ] **Step 5: check + 提交**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -c Error`
Expected: `0`（若报 OutlinePanel 引用未定义键属预期，Task 2 修）

```bash
git add src/lib/i18n/en.ts src/lib/i18n/zh.ts src/lib/i18n/de.ts src/lib/i18n/ja.ts
git commit -m "feat(outline): i18n for pencil menu (open-as-markdown / delete)"
```

---

## Task 2: OutlinePanel 铅笔菜单

**Files:** Modify `src/components/outline/OutlinePanel.svelte`

- [ ] **Step 1: 替换 `<script>`**

用下面整体替换现有 `<script lang="ts"> ... </script>`：

```svelte
<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import { outlineAppliesTo } from '../../lib/outline/gate.svelte'
  import { setSideVisible } from '../../lib/side-panel/registry.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import { companionPathFor } from '../../lib/outline/store.svelte'
  import { openFile, setMode, closeTab, tabs } from '../../lib/tabs.svelte'
  import OutlineEditor from './OutlineEditor.svelte'
  import SideViewSwitcher from '../side-panel/SideViewSwitcher.svelte'

  let { tab }: { tab: Tab | null } = $props()

  // Whether the current tab has an outline. Drives body state + button enablement.
  let applicable = $derived(tab != null && outlineAppliesTo(tab))
  let companionPath = $derived(applicable && tab ? companionPathFor(tab.filePath) : null)

  // 面板重置计数：删除笔记后自增 → OutlineEditor 重挂 → 重读(文件已无) → 空大纲
  let resetTick = $state(0)

  // 铅笔菜单（fixed 定位，锚到按钮左下）
  let menu = $state<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 })
  let noteExists = $state(false)
  async function toggleMenu(e: MouseEvent) {
    if (menu.open) { menu = { open: false, x: 0, y: 0 }; return }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    noteExists = companionPath
      ? await (await import('@tauri-apps/plugin-fs')).exists(companionPath).catch(() => false)
      : false
    menu = { open: true, x: r.left, y: r.bottom + 2 }
  }
  function closeMenu() { menu = { open: false, x: 0, y: 0 } }

  async function openMarkdown() {
    closeMenu()
    if (!companionPath) return
    const { exists } = await import('@tauri-apps/plugin-fs')
    if (await exists(companionPath).catch(() => false)) {
      await openFile(companionPath)
    } else {
      // 惰性：磁盘上还没笔记 → 打开未保存 buffer（同样以源码显示模板）
      const [{ openNewOutlineTab }, { pageNameOf }, { newOutlineFileText }] = await Promise.all([
        import('../../lib/tabs.svelte'),
        import('../../lib/outline/backlinks'),
        import('../../lib/outline/create'),
      ])
      await openNewOutlineTab(companionPath, newOutlineFileText(pageNameOf(companionPath)))
    }
    const opened = tabs.find((x) => x.filePath === companionPath)
    if (opened) setMode(opened.id, 'source')   // source 路由先于 isOutlineNoteTab → 原始 Markdown
  }

  async function deleteNote() {
    closeMenu()
    if (!companionPath) return
    const { exists, remove } = await import('@tauri-apps/plugin-fs')
    if (!(await exists(companionPath).catch(() => false))) return
    const { ask } = await import('@tauri-apps/plugin-dialog')
    const ok = await ask(t('outline.deleteNoteConfirm'), {
      title: t('outline.deleteNote'), kind: 'warning',
      okLabel: t('outline.deleteNote'), cancelLabel: t('common.cancel'),
    })
    if (!ok) return
    const openTab = tabs.find((x) => x.filePath === companionPath)
    if (openTab) await closeTab(openTab.id, async () => 'discard' as const)   // 删前不保存
    await remove(companionPath).catch((e) => console.warn('[outline] delete note failed:', e))
    resetTick++
  }

  function onWindowMouseDown(e: MouseEvent) {
    if (!menu.open) return
    const target = e.target as HTMLElement | null
    if (target?.closest('.pencil-menu') || target?.closest('.pencil-btn')) return
    closeMenu()
  }
  function onWindowKeyDown(e: KeyboardEvent) {
    if (menu.open && e.key === 'Escape') { e.preventDefault(); closeMenu() }
  }
</script>

<svelte:window onmousedown={onWindowMouseDown} onkeydown={onWindowKeyDown} />
```

- [ ] **Step 2: 铅笔按钮改为菜单触发**

把模板里的铅笔 `<button ... onclick={() => void openNoteTab()}>...</button>`（含 svg）整体替换为：

```svelte
    <button class="hbtn pencil-btn" class:on={menu.open} title={t('outline.editNote')} aria-label={t('outline.editNote')} disabled={!companionPath} onclick={toggleMenu}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      </svg>
    </button>
```

- [ ] **Step 3: `{#key}` 加 resetTick**

把 `{#key tab!.id}` 改为：

```svelte
    {#key `${tab!.id}:${resetTick}`}
      <OutlineEditor mainTab={tab} />
    {/key}
```

- [ ] **Step 4: 菜单模板**

在 `</div>`（`.outline-content` 收尾，模板最后一个 `</div>`）之后新增：

```svelte
{#if menu.open}
  <div class="pencil-menu" role="menu" style="left: {menu.x}px; top: {menu.y}px">
    <button type="button" role="menuitem" class="pmenu-row" onclick={() => void openMarkdown()}>{t('outline.openMarkdown')}</button>
    <button type="button" role="menuitem" class="pmenu-row danger" disabled={!noteExists} onclick={() => void deleteNote()}>{t('outline.deleteNote')}</button>
  </div>
{/if}
```

- [ ] **Step 5: 菜单样式**

在 `<style>` 里 `.empty` 规则后新增：

```css
  .pencil-menu {
    position: fixed; z-index: 9998; min-width: 168px;
    background: var(--menu-bg, Canvas); color: CanvasText;
    border: 1px solid var(--border-color, #3335); border-radius: 6px;
    padding: 4px; box-shadow: 0 4px 16px rgba(0,0,0,0.18);
  }
  .pmenu-row {
    display: block; width: 100%; text-align: left; border: 0; background: transparent;
    color: inherit; font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 4px; cursor: pointer;
  }
  .pmenu-row:hover:not(:disabled) { background: rgba(0,0,0,0.08); }
  .pmenu-row.danger:not(:disabled) { color: #d24b4b; }
  .pmenu-row:disabled { opacity: 0.35; cursor: default; }
  @media (prefers-color-scheme: dark) {
    .pmenu-row:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
  }
```

- [ ] **Step 6: check 通过**

Run: `npx svelte-check --tsconfig ./tsconfig.json 2>&1 | grep -c Error`
Expected: `0`

- [ ] **Step 7: 提交**

```bash
git add src/components/outline/OutlinePanel.svelte
git commit -m "feat(outline): pencil menu — open-as-markdown (source) + delete note (confirm)"
```

---

## Task 3: 全量 check + dev GUI 验证

- [ ] **Step 1: check + test**

Run: `pnpm check` （0 error）；`pnpm test` （全绿，无相关回归）。

- [ ] **Step 2: 起 dev**

Run: `pnpm tauri dev`

- [ ] **Step 3: 验收**（[[feedback_no_ui_automation_user_tests]]）

1. 点右上角铅笔 → 弹菜单（两项）；点空白/Esc 关闭。
2. 「使用 Markdown 打开」→ `.note.md` 以**原始 Markdown 源码**打开（不是大纲视图）。
3. 「删除」→ 弹确认框；确认后：文件消失、若开着的 note tab 被关、面板大纲清空；取消则无事发生。
4. 主 md 文件不受影响。
5. 笔记尚未落盘（从没保存过）时，「删除」置灰禁用；「使用 Markdown 打开」仍能惰性打开。

---

## Self-Review 记录

- **Spec 覆盖**：菜单化→Task 2(toggleMenu+模板)；使用 Markdown 打开=source→Task 2(openMarkdown/setMode)；删除+确认+关 tab+重置+无文件禁用→Task 2(deleteNote/closeTab/remove/resetTick/noteExists)；i18n→Task 1。全覆盖。
- **占位符**：无；每步完整代码。
- **类型一致**：`setMode(id,'source')`/`closeTab(id, async()=>'discard' as const)`（DirtyChoice='save'|'discard'|'cancel'）/`companionPathFor`/`openNewOutlineTab`/`newOutlineFileText`/`pageNameOf`/`tabs` 均与既有导出一致；`resetTick`/`menu`/`noteExists` 定义与使用一致。
- **风险**：`closeTab` 的 confirm 回调返回 `'discard' as const` 保证类型；删除只 `remove(companionPath)` 不动主 md；`{#key}` 模板字面量强制重挂重读实现面板清空；菜单 fixed 定位可能被窄面板裁切——按钮左下锚点在面板内，可接受。
