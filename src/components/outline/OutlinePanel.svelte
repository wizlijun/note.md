<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import { outlineAppliesTo } from '../../lib/outline/gate.svelte'
  import { setSideVisible } from '../../lib/side-panel/registry.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import { companionPathFor } from '../../lib/outline/store.svelte'
  import { ensureOutlineFile } from '../../lib/outline/create'
  import { openFile } from '../../lib/tabs.svelte'
  import OutlineEditor from './OutlineEditor.svelte'
  import SideViewSwitcher from '../side-panel/SideViewSwitcher.svelte'

  let { tab }: { tab: Tab | null } = $props()

  // Whether the current tab has an outline. Drives body state + button enablement.
  let applicable = $derived(tab != null && outlineAppliesTo(tab))
  let companionPath = $derived(applicable && tab ? companionPathFor(tab.filePath) : null)

  async function openNoteTab() {
    if (!companionPath) return
    await ensureOutlineFile(companionPath)
    await openFile(companionPath)
  }

</script>

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
    <button class="hbtn" title={t('outline.editNote')} aria-label={t('outline.editNote')} disabled={!companionPath} onclick={() => void openNoteTab()}>
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
    <!-- 全功能大纲编辑器：与主编辑器双向同步（keyed 换文档时整体重挂） -->
    {#key tab!.id}
      <OutlineEditor mainTab={tab} />
    {/key}
  {/if}
</div>

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
  /* 面板窄容器里收紧编辑器的内边距/宽度约束 */
  .outline-content :global(.outline-editor .body) {
    padding: 10px 12px;
    max-width: none;
  }
  @media (prefers-color-scheme: dark) {
    .hbtn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
  }
</style>
