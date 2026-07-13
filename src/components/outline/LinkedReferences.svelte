<script lang="ts">
  import { outline } from '../../lib/outline/store.svelte'
  import { recallGrouped, type RecallGroup } from '../../lib/outline/recall'
  import { openFile } from '../../lib/tabs.svelte'
  import { openPageOrCreate } from '../../lib/outline/backlinks-io.svelte'
  import { commitReferenceEdit } from '../../lib/outline/recall-writeback-io'
  import { t } from '../../lib/i18n/store.svelte'
  import RefTreeNode from './RefTreeNode.svelte'

  let { page = null, excludeFile = null }: { page?: string | null; excludeFile?: string | null } = $props()

  let groups = $state<RecallGroup[]>([])
  const count = $derived(groups.reduce((n, g) => n + g.carriers.length, 0))

  // Recompute on index changes / page switch. recallGrouped is now pure +
  // synchronous (reads the index's cached trees — no disk / re-parse), so this
  // is cheap; a short debounce coalesces rapid bumps (e.g. while typing in the
  // outline). Reads store + index only; assigns local state — no self-loop.
  let timer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    void outline.version
    const p = page
    const idx = outline.backlinkIndex
    if (!p || !idx) { groups = []; return }
    clearTimeout(timer)
    timer = setTimeout(() => { groups = recallGrouped(idx, p, excludeFile ?? undefined) }, 30)
    return () => clearTimeout(timer)
  })

  const fileName = (path: string) => path.split('/').pop() ?? path
  const openSource = (file: string) => void openFile(file)
  // B1: only outline-file sources are editable in place (safe parse↔serialize
  // round-trip); prose .md references stay read-only.
  const isOutlineFile = (f: string) => /\.notes?\.md$/i.test(f)
  // Wikilink / hashtag inside a reference navigates (same as the outline).
  const onPageClick = (target: string) => void openPageOrCreate(target)
</script>

{#if count > 0}
  <section class="linked-refs">
    <header class="lr-head">
      <span class="lr-title">{count} {t('outline.linkedReferences')}</span>
      <span class="lr-actions">
        <button class="icon" title="Search" disabled aria-label="search">⌕</button>
        <button class="icon" title="Filter" disabled aria-label="filter">⚑</button>
        <button class="icon" title="More" disabled aria-label="more">⋯</button>
      </span>
    </header>

    {#each groups as g (g.file)}
      {@const editable = isOutlineFile(g.file)}
      <div class="lr-group">
        <button class="lr-file" onclick={() => void openFile(g.file)}>{fileName(g.file)}</button>
        {#each g.carriers as carrier, i (i)}
          <div class="lr-carrier">
            {#if carrier.breadcrumb.length}
              <button class="lr-crumb" onclick={() => openSource(g.file)} title={g.file}
                >/{carrier.breadcrumb.join('/')}</button>
            {/if}
            <RefTreeNode
              node={carrier.node}
              defaultCollapsed={true}
              {editable}
              {onPageClick}
              onCommit={(path, oldText, newText) => commitReferenceEdit(g.file, path, oldText, newText)}
            />
          </div>
        {/each}
      </div>
    {/each}
  </section>
{/if}

<style>
  /* Inherit the main outline's typography so the whole section reads as one
     continuous outline; header/breadcrumb are sized relative to it. */
  .linked-refs {
    margin-top: 20px;
    font-family: var(--outline-font-family);
    font-size: var(--outline-font-size, 13px);
    line-height: var(--outline-line-height, 1.5);
  }
  .lr-head {
    display: flex; align-items: center; justify-content: space-between;
    border-top: 1px solid var(--border-color, #3333);
    padding: 8px 2px 6px; margin-bottom: 4px;
  }
  .lr-title { font-size: 0.85em; font-weight: 600; opacity: 0.6; letter-spacing: 0.02em; }
  .lr-actions { display: flex; gap: 2px; }
  .icon {
    background: none; border: none; color: inherit; cursor: pointer;
    font-size: 1em; opacity: 0.4; padding: 2px 5px; border-radius: 4px;
  }
  .icon:disabled { cursor: default; }
  .icon:not(:disabled):hover { opacity: 0.9; background: var(--hover-bg, #8881); }
  .lr-group { margin: 6px 0 10px; }
  .lr-file {
    background: none; border: none; text-align: left; cursor: pointer; padding: 2px 4px;
    border-radius: 4px; color: inherit; font-size: 1em; font-weight: 600; opacity: 0.85;
  }
  .lr-file:hover { background: var(--hover-bg, #8881); text-decoration: underline; }
  .lr-carrier { padding: 2px 0 2px 12px; }
  .lr-crumb {
    display: block; background: none; border: none; text-align: left; cursor: pointer;
    color: inherit; opacity: 0.45; font-size: 0.82em; padding: 0 4px 2px; font-family: inherit;
  }
  .lr-crumb:hover { opacity: 0.8; text-decoration: underline; }
</style>
