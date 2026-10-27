<script lang="ts">
  import { onMount } from 'svelte'
  import { quickPlaceInput, type QuickPlaceInput } from '../lib/events'
  import { t, type MessageKey } from '../lib/strings'

  let { anchor, itemTitle, saving, onCancel, onSelect, onMore, onCompleteWithNote }: {
    anchor: HTMLButtonElement
    itemTitle: string
    saving: boolean
    onCancel(): void
    onSelect(input: QuickPlaceInput): void
    onMore(): void
    onCompleteWithNote?(): void
  } = $props()

  const options = [
    ['commit', 'route.commit'],
    ['wait', 'route.wait'],
    ['park', 'route.park'],
    ['done', 'exit.done'],
    ['stopped', 'exit.stopped'],
    ['transferred', 'action.transfer'],
  ] as const satisfies readonly (readonly [Parameters<typeof quickPlaceInput>[0], MessageKey])[]
  const optionOffset = $derived(onCompleteWithNote ? 1 : 0)
  let menu: HTMLDivElement
  let x = $state(8)
  let y = $state(8)
  let active = $state(-1)

  function position() {
    const rect = anchor.getBoundingClientRect()
    x = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))
    const below = rect.bottom + 4
    y = Math.max(8, Math.min(below + menu.offsetHeight <= window.innerHeight - 8
      ? below : rect.top - menu.offsetHeight - 4, window.innerHeight - menu.offsetHeight - 8))
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!saving) onCancel()
      return
    }
    if (event.key === 'Tab') {
      if (!saving) onCancel()
      return
    }
    if (saving) return
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('button')]
    let next = active
    if (event.key === 'ArrowDown') next = (active + 1) % rows.length
    else if (event.key === 'ArrowUp') next = active < 0 ? rows.length - 1 : (active - 1 + rows.length) % rows.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else return
    event.preventDefault()
    active = next
    rows[next].focus()
  }

  onMount(() => {
    position()
    menu.focus()
    const outside = (event: PointerEvent) => {
      if (!saving && event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) onCancel()
    }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      if (document.activeElement === document.body || menu.contains(document.activeElement)) anchor.focus()
    }
  })
</script>

<div bind:this={menu} class="place-menu menu-panel" role="menu" tabindex="-1"
  aria-label={t('sheet.title', { title: itemTitle })} aria-busy={saving}
  style:left={`${x}px`} style:top={`${y}px`} onkeydown={keydown}>
  {#if onCompleteWithNote}
    <button type="button" class="menu-row" class:active={active === 0} role="menuitem"
      tabindex="-1" disabled={saving} onfocus={() => active = 0} onpointerenter={() => active = -1}
      onclick={onCompleteWithNote}>{t('action.completeWithNote')}</button>
  {/if}
  {#each options as [action, label], index}
    <button type="button" class="menu-row" class:active={active === index + optionOffset} role="menuitem"
      tabindex="-1" disabled={saving} onfocus={() => active = index + optionOffset} onpointerenter={() => active = -1}
      onclick={() => onSelect(quickPlaceInput(action))}>{t(label)}</button>
  {/each}
  <div class="menu-sep" role="separator"></div>
  <button type="button" class="menu-row" class:active={active === options.length + optionOffset} role="menuitem"
    tabindex="-1" disabled={saving} onfocus={() => active = options.length + optionOffset} onpointerenter={() => active = -1}
    onclick={onMore}>{t('action.placeMore')}</button>
</div>

<style>
  .place-menu { position: fixed; z-index: 30; min-width: 180px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; box-sizing: border-box; }
  .menu-row { width: 100%; min-height: 28px; border: 0; background: none; color: inherit; font: inherit; text-align: left; }
  .menu-row:disabled { opacity: 0.45; }
</style>
