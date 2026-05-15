<script lang="ts">
  import { activeTab } from '../lib/tabs.svelte'
  import { dispatch } from '../lib/commands'
  import { formFactor } from '../lib/platform.svelte'

  let { onOpenDrawer = () => {} }: { onOpenDrawer?: () => void } = $props()
  let menuOpen = $state(false)
  let tab = $derived(activeTab())
  let dirty = $derived(tab && tab.currentContent !== tab.initialContent)
</script>

<header class="mtb" style="display: var(--toolbar-display)">
  {#if formFactor.value === 'phone'}
    <button class="hamburger" aria-label="Open menu" onclick={onOpenDrawer}>☰</button>
  {/if}
  <div class="title">
    {tab?.title ?? 'M↓'}
    {#if dirty}<span class="dirty" aria-label="unsaved">•</span>{/if}
  </div>
  <div class="actions">
    {#if tab && tab.kind !== 'image'}
      <button onclick={() => dispatch('toggle-mode')} title="Toggle source/rich">⇄</button>
    {/if}
    <button onclick={() => (menuOpen = !menuOpen)} aria-label="More">⋯</button>
  </div>

  {#if menuOpen}
    <div class="menu" role="menu">
      <button role="menuitem" onclick={() => { menuOpen = false; dispatch('save') }}>Save</button>
      <button role="menuitem" onclick={() => { menuOpen = false; dispatch('save-as') }}>Save As…</button>
      <button role="menuitem" onclick={() => { menuOpen = false; dispatch('share') }}>Share</button>
      <button role="menuitem" onclick={() => { menuOpen = false; dispatch('preferences') }}>Settings</button>
    </div>
  {/if}
</header>

<style>
  .mtb {
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid rgba(0,0,0,0.08);
    background: var(--mtb-bg, rgba(255,255,255,0.95));
    position: relative;
  }
  .hamburger { font-size: 20px; padding: 6px 10px; }
  .title {
    flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500;
  }
  .dirty { color: var(--accent, #1a73e8); margin-left: 4px; }
  .actions { display: flex; gap: 4px; }
  .actions button { padding: 6px 10px; font-size: 18px; background: transparent; border: 0; cursor: pointer; }
  .menu {
    position: absolute; top: 100%; right: 12px;
    background: white; border: 1px solid rgba(0,0,0,0.1);
    border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.1);
    display: flex; flex-direction: column; min-width: 180px; z-index: 50;
  }
  .menu button {
    text-align: left; padding: 10px 14px; background: transparent; border: 0;
    font: inherit; cursor: pointer;
  }
  .menu button:hover { background: rgba(0,0,0,0.04); }
  @media (prefers-color-scheme: dark) {
    .mtb { background: var(--mtb-bg, rgba(28,28,30,0.95)); border-color: rgba(255,255,255,0.08); }
    .menu { background: #2c2c2e; border-color: rgba(255,255,255,0.1); }
    .menu button:hover { background: rgba(255,255,255,0.06); }
  }
</style>
