<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import type { Side } from '../../lib/side-panel/model'
  import {
    sidePanels, sideActiveView, isSideVisible, setSideWidth, setSideWidthLive,
  } from '../../lib/side-panel/registry.svelte'

  let { side, tab }: { side: Side; tab: Tab | null } = $props()

  let visible = $derived(isSideVisible(side, tab))
  let active = $derived(sideActiveView(side, tab))

  let startX = 0
  let startW = 0
  function onSplitterDown(e: PointerEvent) {
    startX = e.clientX
    startW = sidePanels[side].width
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onSplitterMove(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    if (!el.hasPointerCapture(e.pointerId)) return
    const delta = side === 'left' ? e.clientX - startX : startX - e.clientX
    setSideWidthLive(side, startW + delta)
  }
  function onSplitterUp(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement
    if (!el.hasPointerCapture(e.pointerId)) return
    el.releasePointerCapture(e.pointerId)
    void setSideWidth(side, sidePanels[side].width)
  }
</script>

{#if visible && active}
  <aside class="side-panel {side}" style="width: {sidePanels[side].width}px">
    {#if side === 'right'}
      <div class="splitter" role="separator" aria-orientation="vertical" onpointerdown={onSplitterDown} onpointermove={onSplitterMove} onpointerup={onSplitterUp}></div>
    {/if}

    <div class="content">
      {#key active.id}
        {#await active.component() then Mod}
          <Mod.default {tab} />
        {/await}
      {/key}
    </div>

    {#if side === 'left'}
      <div class="splitter" role="separator" aria-orientation="vertical" onpointerdown={onSplitterDown} onpointermove={onSplitterMove} onpointerup={onSplitterUp}></div>
    {/if}
  </aside>
{/if}

<style>
  .side-panel {
    position: relative;
    flex: 0 0 auto;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .side-panel.left { border-right: 1px solid var(--border-color, #3333); }
  .side-panel.right { border-left: 1px solid var(--border-color, #3333); }
  .splitter {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 5px;
    cursor: col-resize;
    z-index: 5;
    touch-action: none;
  }
  .side-panel.left .splitter { right: 0; }
  .side-panel.right .splitter { left: 0; }
  .splitter:hover { background: rgba(0, 0, 0, 0.08); }
  .content { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  /* Content components fill the container. */
  .content :global(> *) { flex: 1; min-height: 0; }
  @media (prefers-color-scheme: dark) {
    .splitter:hover { background: rgba(255, 255, 255, 0.1); }
  }
</style>
