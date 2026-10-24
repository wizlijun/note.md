<script module lang="ts">
  export interface EditorActions {
    run(id: string): void | Promise<void>
    canRun(id: string): boolean
  }
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import { getMenuModel, type MenuItemSpec } from './menu-model'
  import { iconSvg } from './icons'

  let {
    position,
    hasSelection,
    actions,
    onClose,
    image = false,
    resource,
    readOnly = false,
    traceInstalled = false,
    allowImageInsert = true,
  }: {
    position: { x: number; y: number }
    hasSelection: boolean
    actions: EditorActions
    onClose: () => void
    image?: boolean
    resource?: 'local' | 'remote'
    readOnly?: boolean
    traceInstalled?: boolean
    allowImageInsert?: boolean
  } = $props()

  // Host capabilities are supplied by the caller; the menu also runs on shared pages.
  const groups = getMenuModel({
    hasSelection,
    table: untrack(() => actions.canRun('table-align-center')),
    image,
    resource: untrack(() => resource),
    readOnly,
    traceInstalled: untrack(() => traceInstalled),
    allowImageInsert: untrack(() => allowImageInsert),
  })

  let menuEl: HTMLDivElement | undefined = $state()
  let top = $state(position.y)
  let left = $state(position.x)
  let openSubId = $state<string | null>(null)
  let subMenuEl: HTMLDivElement | undefined = $state()
  let subAnchor = $state({ top: 0, left: 0, right: 0 })
  let subTop = $state(0), subLeft = $state(0)
  const openSub = $derived(groups.flatMap(group => group.items).find(item => item.id === openSubId))

  $effect(() => {
    if (!menuEl) return
    const r = menuEl.getBoundingClientRect()
    top = (position.y + r.height > window.innerHeight)
      ? Math.max(4, window.innerHeight - r.height - 4) : position.y
    left = (position.x + r.width > window.innerWidth)
      ? Math.max(4, window.innerWidth - r.width - 4) : position.x
  })
  $effect(() => {
    if (!subMenuEl) return
    const r = subMenuEl.getBoundingClientRect()
    subTop = Math.max(4, Math.min(subAnchor.top - 6, window.innerHeight - r.height - 4))
    subLeft = subAnchor.right + r.width > window.innerWidth ? Math.max(4, subAnchor.left - r.width) : subAnchor.right
  })
  function openSubmenu(event: MouseEvent, item: MenuItemSpec) {
    openSubId = item.children ? item.id : null
    if (item.children) {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
      subAnchor = { top: rect.top, left: rect.left, right: rect.right }
    }
  }

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
    class="ctx-menu menu-panel"
    style="top: {top}px; left: {left}px"
    onclick={(e) => e.stopPropagation()}
  >
    {#each groups as group, gi (group.id)}
      {#if gi > 0}<div class="menu-sep"></div>{/if}
      {#each group.items as it (it.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="ctx-item menu-row"
          class:disabled={disabled(it)}
          class:active={openSubId === it.id}
          aria-disabled={disabled(it)}
          onmouseenter={(event) => openSubmenu(event, it)}
          onclick={() => choose(it)}
        >
          {#if it.emphasis && it.icon}<span class="ctx-ic">{@html iconSvg(it.icon)}</span>{/if}
          <span class="ctx-label">{it.label}</span>
          {#if it.children}<span class="ctx-arrow">▸</span>{/if}

        </div>
      {/each}
    {/each}
  </div>
  {#if openSub?.children}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div bind:this={subMenuEl} class="ctx-sub menu-panel" style="top: {subTop}px; left: {subLeft}px" onclick={(event) => event.stopPropagation()}>
      {#each openSub.children as sub (sub.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="menu-row" class:disabled={disabled(sub)} aria-disabled={disabled(sub)} onclick={() => choose(sub)}>
          <span class="ctx-label">{sub.label}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Chrome (background/blur/highlight) comes from the shared .menu-panel /
     .menu-row classes in app.css — only layout lives here. */
  .ctx-backdrop { position: fixed; inset: 0; z-index: 80; }
  .ctx-menu { position: fixed; min-width: 180px; z-index: 81; }
  .ctx-menu, .ctx-sub { max-height:calc(100vh - 8px); max-height:calc(100dvh - 8px); max-width:calc(100vw - 8px); overflow:auto; }
  .ctx-item { position: relative; }
  .ctx-ic { flex: 0 0 auto; display: inline-flex; margin-right: 6px; }
  .ctx-label { flex: 1; }
  .ctx-arrow { margin-left: 16px; opacity: 0.6; font-size: 11px; }
  .ctx-item:hover > .ctx-arrow { opacity: 1; }
  .ctx-sub {
    position: fixed; min-width: 140px; z-index:82;
    color: CanvasText;
  }
</style>
