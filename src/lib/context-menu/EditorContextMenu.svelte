<script module lang="ts">
  export interface EditorActions {
    run(id: string): void | Promise<void>
    canRun(id: string): boolean
  }
</script>

<script lang="ts">
  import { getMenuModel, type MenuItemSpec } from './menu-model'

  let {
    position,
    hasSelection,
    actions,
    onClose,
  }: {
    position: { x: number; y: number }
    hasSelection: boolean
    actions: EditorActions
    onClose: () => void
  } = $props()

  const groups = getMenuModel({ hasSelection })

  let menuEl: HTMLDivElement | undefined = $state()
  let top = $state(position.y)
  let left = $state(position.x)
  let openSubId = $state<string | null>(null)

  $effect(() => {
    if (!menuEl) return
    const r = menuEl.getBoundingClientRect()
    top = (position.y + r.height > window.innerHeight)
      ? Math.max(4, window.innerHeight - r.height - 4) : position.y
    left = (position.x + r.width > window.innerWidth)
      ? Math.max(4, window.innerWidth - r.width - 4) : position.x
  })

  function disabled(it: MenuItemSpec): boolean {
    if (it.children) return false
    if (it.needsSelection && !hasSelection) return true
    return !actions.canRun(it.id)
  }

  async function choose(it: MenuItemSpec) {
    if (it.children) return
    if (disabled(it)) return
    onClose()
    await actions.run(it.id)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="ctx-backdrop" oncontextmenu={(e) => { e.preventDefault(); onClose() }} onclick={onClose}>
  <div
    bind:this={menuEl}
    class="ctx-menu"
    style="top: {top}px; left: {left}px"
    onclick={(e) => e.stopPropagation()}
  >
    {#each groups as group, gi (group.id)}
      {#if gi > 0}<div class="ctx-sep"></div>{/if}
      {#each group.items as it (it.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="ctx-item"
          class:disabled={disabled(it)}
          onmouseenter={() => openSubId = it.children ? it.id : null}
          onclick={() => choose(it)}
        >
          <span class="ctx-label">{it.label}</span>
          {#if it.children}<span class="ctx-arrow">▸</span>{/if}

          {#if it.children && openSubId === it.id}
            <div class="ctx-sub">
              {#each it.children as sub (sub.id)}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="ctx-item" onclick={(e) => { e.stopPropagation(); choose(sub) }}>
                  <span class="ctx-label">{sub.label}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/each}
  </div>
</div>

<style>
  /* Plain macOS-style menu: text-only rows, native accent highlight,
     no icons / weights / per-item colors. */
  .ctx-backdrop { position: fixed; inset: 0; z-index: 80; }
  .ctx-menu {
    position: fixed; min-width: 180px; padding: 5px;
    background: Canvas; color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas);
    border-radius: 6px;
    box-shadow: 0 6px 18px color-mix(in srgb, CanvasText 22%, transparent);
    z-index: 81; font-size: 13px;
  }
  .ctx-sep { height: 1px; margin: 5px 10px; background: color-mix(in srgb, CanvasText 12%, Canvas); }
  .ctx-item {
    position: relative; display: flex; align-items: center;
    padding: 3px 10px; border-radius: 4px; cursor: default; user-select: none;
    white-space: nowrap;
  }
  .ctx-item:hover { background: AccentColor; color: AccentColorText; }
  .ctx-item.disabled { opacity: 0.35; pointer-events: none; }
  .ctx-label { flex: 1; }
  .ctx-arrow { margin-left: 16px; opacity: 0.6; font-size: 11px; }
  .ctx-item:hover > .ctx-arrow { opacity: 1; }
  .ctx-sub {
    position: absolute; top: -6px; left: 100%; min-width: 140px; padding: 5px;
    background: Canvas; color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 15%, Canvas);
    border-radius: 6px;
    box-shadow: 0 6px 18px color-mix(in srgb, CanvasText 22%, transparent);
  }
</style>
