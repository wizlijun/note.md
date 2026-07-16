<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { deviceSourceForVaultPath, isMirrorPath, relinkMirrorSource, revealVaultSource } from '../lib/sotvault.svelte'
  import { openFile } from '../lib/tabs.svelte'
  import { t } from '../lib/i18n/store.svelte'

  let { tab }: { tab: Tab } = $props()

  // This device's recorded source (from git-synced mirror metas), and whether
  // this vault file is a mirror recorded by ANY device.
  const source = $derived(deviceSourceForVaultPath(tab.filePath || null))
  const mirror = $derived(isMirrorPath(tab.filePath || null))

  // Does this device's source still exist on disk? null = unknown/checking.
  let sourceExists = $state<boolean | null>(null)
  $effect(() => {
    const s = source
    sourceExists = null
    if (!s) return
    import('@tauri-apps/plugin-fs').then(({ exists }) => exists(s).catch(() => false)).then((ok) => { sourceExists = ok })
  })

  let busy = $state(false)
  async function onRelink() {
    if (!tab.filePath) return
    busy = true
    try { await relinkMirrorSource(tab.filePath) } finally { busy = false }
  }
</script>

{#if source && sourceExists}
  <div class="banner sync-origin" role="status" aria-live="polite">
    <span class="label">{t('syncOrigin.synced')}</span>
    <button
      class="origin-link"
      title={t('syncOrigin.revealTitle')}
      onclick={() => revealVaultSource(source)}
    >{source}</button>
    <button class="action" onclick={() => openFile(source)}>{t('syncOrigin.editSource')}</button>
  </div>
{:else if mirror || source}
  <div class="banner sync-origin" role="status" aria-live="polite">
    <span class="label">{t('syncOrigin.sourceMissing')}</span>
    <button class="action" onclick={onRelink} disabled={busy}>{t('syncOrigin.relink')}</button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 8px;
    /* Reserve the top-right corner for the floating ModeToggle (single-tab view)
       so the action button isn't hidden underneath it. */
    padding: 6px 104px 6px 10px;
    font-size: 12px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
  }
  .banner.sync-origin {
    background: #cfe2ff;
    color: #084298;
  }
  .label { white-space: nowrap; }
  .origin-link {
    flex: 1;
    min-width: 0;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: transparent;
    border: 0;
    padding: 0;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  .origin-link:hover { opacity: 0.8; }
  .action {
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    background: rgba(255, 255, 255, 0.5);
    color: inherit;
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
  }
  .action:hover { background: rgba(255, 255, 255, 0.85); }
</style>
