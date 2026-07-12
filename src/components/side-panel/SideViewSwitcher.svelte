<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import type { Side } from '../../lib/side-panel/model'
  import { sideShownViews, sideActiveView, setActiveView } from '../../lib/side-panel/registry.svelte'

  // Lives in a side panel's header title slot. With ≥2 available views it is a
  // dropdown that switches the active view; with ≤1 it renders the plain title
  // (so a single-view side looks exactly like a static title).
  let { side, tab }: { side: Side; tab: Tab | null } = $props()

  let shown = $derived(sideShownViews(side, tab))
  let active = $derived(sideActiveView(side, tab))
  let canSwitch = $derived(shown.length >= 2)

  let open = $state(false)
  let rootEl: HTMLElement | undefined

  function toggle() {
    if (canSwitch) open = !open
  }
  function pick(id: string) {
    open = false
    void setActiveView(side, id)
  }
  function onWindowMouseDown(e: MouseEvent) {
    if (!open) return
    if (rootEl && rootEl.contains(e.target as Node)) return
    open = false
  }
  function onWindowKeyDown(e: KeyboardEvent) {
    if (open && e.key === 'Escape') {
      e.preventDefault()
      open = false
    }
  }
</script>

<svelte:window onmousedown={onWindowMouseDown} onkeydown={onWindowKeyDown} />

<div class="switcher" bind:this={rootEl}>
  {#if canSwitch}
    <button
      class="trigger"
      class:open
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      onclick={toggle}
    >
      <span class="label">{active?.title() ?? ''}</span>
      <svg class="chev" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </button>
    {#if open}
      <div class="menu menu-panel" role="menu">
        {#each shown as v (v.id)}
          <button
            class="menu-row row"
            type="button"
            role="menuitemradio"
            aria-checked={v.id === active?.id}
            onclick={() => pick(v.id)}
          >
            <span class="check">{v.id === active?.id ? '✓' : ''}</span>
            <span class="name">{v.title()}</span>
          </button>
        {/each}
      </div>
    {/if}
  {:else}
    <span class="plain">{active?.title() ?? ''}</span>
  {/if}
</div>

<style>
  .switcher {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    max-width: 100%;
    border: 0;
    background: transparent;
    cursor: pointer;
    font: inherit;
    color: inherit;
    padding: 2px 6px 2px 4px;
    margin: -2px 0;
    border-radius: 5px;
  }
  .trigger:hover,
  .trigger.open { background: rgba(0, 0, 0, 0.08); }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev { flex: 0 0 auto; opacity: 0.6; }
  .plain {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 9999;
    min-width: 160px;
  }
  .row {
    width: 100%;
    border: 0;
    background: transparent;
    font: inherit;
    text-align: left;
    gap: 6px;
  }
  .check {
    flex: 0 0 auto;
    width: 12px;
    text-align: center;
  }
  .name { flex: 1; }
  @media (prefers-color-scheme: dark) {
    .trigger:hover,
    .trigger.open { background: rgba(255, 255, 255, 0.12); }
  }
</style>
