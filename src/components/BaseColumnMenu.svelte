<script lang="ts">
  import type { ColumnMenuAction } from '../lib/base/model'
  import { t } from '../lib/i18n/store.svelte'

  let {
    x, y, displayName, isGroup, isSort, onAction, onClose,
  }: {
    x: number
    y: number
    displayName: string
    isGroup: boolean
    isSort: boolean
    onAction: (a: ColumnMenuAction) => void
    onClose: () => void
  } = $props()

  let renaming = $state(false)
  let draft = $state('')
  // `done` guards against the input's blur firing again after Enter/Escape has
  // already unmounted the menu (which would call onAction with a null colMenu).
  let done = $state(false)

  let el = $state<HTMLDivElement | null>(null)
  let pos = $state({ left: x, top: y })
  // Keep the panel fully on screen — shifts left so the right edge stays inside
  // the viewport (right-aligns the rightmost column's menu instead of clipping).
  $effect(() => {
    const node = el
    if (!node) return
    const w = node.offsetWidth, h = node.offsetHeight
    pos = {
      left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    }
  })

  function startRename() {
    draft = displayName
    renaming = true
  }
  function commitRename() {
    if (done) return
    done = true
    onAction({ kind: 'rename', name: draft })
    onClose()
  }
  function cancelRename() {
    if (done) return
    done = true
    onClose()
  }
</script>

<svelte:window onclick={onClose} oncontextmenu={onClose} />

<div bind:this={el} class="menu-panel base-menu" style="left:{pos.left}px; top:{pos.top}px" role="menu" tabindex="-1"
     onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Escape') onClose() }}>
  {#if renaming}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      class="rename-input"
      bind:value={draft}
      placeholder={t('base.colRenamePlaceholder')}
      autofocus
      onkeydown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') cancelRename() }}
      onblur={commitRename}
    />
  {:else}
    <button type="button" role="menuitem" class="menu-row mrow" onclick={startRename}>{t('base.colRename')}</button>
    <div class="menu-sep"></div>
    <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onAction({ kind: 'sort', direction: 'ASC' }); onClose() }}>{t('base.colSortAsc')}</button>
    <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onAction({ kind: 'sort', direction: 'DESC' }); onClose() }}>{t('base.colSortDesc')}</button>
    {#if isSort}
      <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onAction({ kind: 'clearSort' }); onClose() }}>{t('base.colClearSort')}</button>
    {/if}
    <div class="menu-sep"></div>
    {#if isGroup}
      <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onAction({ kind: 'ungroup' }); onClose() }}>{t('base.colUngroup')}</button>
    {:else}
      <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onAction({ kind: 'group', direction: 'ASC' }); onClose() }}>{t('base.colGroupAsc')}</button>
      <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onAction({ kind: 'group', direction: 'DESC' }); onClose() }}>{t('base.colGroupDesc')}</button>
    {/if}
    <div class="menu-sep"></div>
    <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onAction({ kind: 'move', delta: -1 }); onClose() }}>{t('base.colMoveLeft')}</button>
    <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onAction({ kind: 'move', delta: 1 }); onClose() }}>{t('base.colMoveRight')}</button>
    <div class="menu-sep"></div>
    <button type="button" role="menuitem" class="menu-row mrow" onclick={() => { onAction({ kind: 'remove' }); onClose() }}>{t('base.colRemove')}</button>
  {/if}
</div>

<style>
  /* Position + button reset only; visual style comes from the global
     .menu-panel / .menu-row classes so base menus match the app's menus. */
  .base-menu { position: fixed; z-index: 9998; min-width: 180px; display: flex; flex-direction: column; }
  .mrow { width: 100%; text-align: left; background: none; color: inherit; border: 0; font: inherit; cursor: default; }
  .rename-input {
    margin: 2px; padding: 4px 8px; font: inherit; font-size: 13px;
    background: color-mix(in srgb, CanvasText 6%, Canvas); color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 6px;
  }
</style>
