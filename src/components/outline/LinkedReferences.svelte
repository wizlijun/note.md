<script lang="ts">
  import { outline } from '../../lib/outline/store.svelte'
  import { recallGrouped, type RecallGroup } from '../../lib/outline/recall'
  import { openFile } from '../../lib/tabs.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import RefTreeNode from './RefTreeNode.svelte'

  let { page = null, excludeFile = null }: { page?: string | null; excludeFile?: string | null } = $props()

  let groups = $state<RecallGroup[]>([])
  const count = $derived(groups.reduce((n, g) => n + g.carriers.length, 0))

  // Recompute on index changes / page switch. Reads store + index (no store
  // writes); assigns only local state — no self-invalidation loop.
  $effect(() => {
    void outline.version
    const p = page
    const idx = outline.backlinkIndex
    if (!p || !idx) { groups = []; return }
    let cancelled = false
    void recallGrouped(idx, p, excludeFile ?? undefined).then(r => { if (!cancelled) groups = r })
    return () => { cancelled = true }
  })

  const fileName = (path: string) => path.split('/').pop() ?? path
  // Phase A: breadcrumb segments jump to the source file (inline per-level
  // expansion is deferred to Phase B along with in-place editing).
  const openSource = (file: string) => void openFile(file)
</script>

{#if count > 0}
  <section class="linked-refs">
    <header class="lr-head">
      <span class="lr-title">{count} {t('outline.backlinks')}</span>
      <span class="lr-actions">
        <button class="icon" title="Search" disabled aria-label="search">⌕</button>
        <button class="icon" title="Filter" disabled aria-label="filter">⚑</button>
        <button class="icon" title="More" disabled aria-label="more">⋯</button>
      </span>
    </header>

    {#each groups as g (g.file)}
      <div class="lr-group">
        <button class="lr-file" onclick={() => void openFile(g.file)}>{fileName(g.file)}</button>
        {#each g.carriers as carrier, i (i)}
          <div class="lr-carrier">
            {#if carrier.breadcrumb.length}
              <button class="lr-crumb" onclick={() => openSource(g.file)} title={g.file}
                >/{carrier.breadcrumb.join('/')}</button>
            {/if}
            <RefTreeNode node={carrier.node} defaultCollapsed={true} />
          </div>
        {/each}
      </div>
    {/each}
  </section>
{/if}

<style>
  .linked-refs { margin-top: 20px; }
  .lr-head {
    display: flex; align-items: center; justify-content: space-between;
    border-top: 1px solid var(--border-color, #3333);
    padding: 8px 2px 6px; margin-bottom: 4px;
  }
  .lr-title { font-size: 12px; font-weight: 600; opacity: 0.6; letter-spacing: 0.02em; }
  .lr-actions { display: flex; gap: 2px; }
  .icon {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 13px; opacity: 0.4; padding: 2px 5px; border-radius: 4px;
  }
  .icon:disabled { cursor: default; }
  .icon:not(:disabled):hover { opacity: 0.9; background: var(--hover-bg, #8881); }
  .lr-group { margin: 6px 0 10px; }
  .lr-file {
    background: none; border: none; text-align: left; cursor: pointer; padding: 2px 4px;
    border-radius: 4px; color: inherit; font-size: 13px; font-weight: 600; opacity: 0.85;
  }
  .lr-file:hover { background: var(--hover-bg, #8881); text-decoration: underline; }
  .lr-carrier { padding: 2px 0 2px 12px; }
  .lr-crumb {
    display: block; background: none; border: none; text-align: left; cursor: pointer;
    color: inherit; opacity: 0.45; font-size: 11px; padding: 0 4px 2px; font-family: inherit;
  }
  .lr-crumb:hover { opacity: 0.8; text-decoration: underline; }
</style>
