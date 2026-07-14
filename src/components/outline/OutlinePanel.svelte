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

<div class="outline-content">
  <header>
    <button class="hbtn" title={t('outline.hide')} aria-label={t('outline.hide')} onclick={() => void setSideVisible('right', false)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="15" y1="3" x2="15" y2="21" />
        <polyline points="8 9 11 12 8 15" />
      </svg>
    </button>
    <SideViewSwitcher side="right" {tab} />
    <button class="hbtn pencil-btn" class:on={menu.open} title={t('outline.editNote')} aria-label={t('outline.editNote')} disabled={!companionPath} onclick={toggleMenu}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      </svg>
    </button>
  </header>
  {#if !applicable || !companionPath}
    <div class="body">
      <p class="empty">{tab == null ? t('outline.noDocument') : t('outline.notApplicable')}</p>
    </div>
  {:else}
    <!-- 全功能大纲编辑器：与主编辑器双向同步（keyed 换文档/删除后整体重挂） -->
    {#key `${tab!.id}:${resetTick}`}
      <OutlineEditor mainTab={tab} />
    {/key}
  {/if}
</div>

{#if menu.open}
  <div class="pencil-menu" role="menu" style="left: {menu.x}px; top: {menu.y}px">
    <button type="button" role="menuitem" class="pmenu-row" onclick={() => void openMarkdown()}>{t('outline.openMarkdown')}</button>
    <button type="button" role="menuitem" class="pmenu-row danger" disabled={!noteExists} onclick={() => void deleteNote()}>{t('outline.deleteNote')}</button>
  </div>
{/if}

<style>
  .outline-content {
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  header {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    border-bottom: 1px solid var(--border-color, #3333);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .hbtn {
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; background: transparent; cursor: pointer;
    padding: 3px; border-radius: 4px; opacity: 0.7;
  }
  .hbtn svg { display: block; }
  .hbtn:hover:not(:disabled) { background: rgba(0,0,0,0.08); opacity: 1; }
  .hbtn:disabled { opacity: 0.25; cursor: default; }
  .body { flex: 1; overflow-y: auto; padding: 8px; }
  .empty { opacity: 0.5; font-size: 12px; }
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
  /* 面板窄容器里收紧编辑器的内边距/宽度约束 */
  .outline-content :global(.outline-editor .body) {
    padding: 10px 12px;
    max-width: none;
  }
  @media (prefers-color-scheme: dark) {
    .hbtn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
  }
</style>
