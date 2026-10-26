<script lang="ts">
  import { onMount } from 'svelte'
  import type { ReminderInput, ReminderView } from '../lib/reminders'
  import { t, type MessageKey } from '../lib/strings'
  import { localDateTimeValue, localTimeZone, tomorrowAtNine } from './reminder-time'

  let { anchor, itemTitle, view, saving, onCancel, onSelect, onMore }: {
    anchor: HTMLButtonElement
    itemTitle: string
    view: ReminderView
    saving: boolean
    onCancel(): void
    onSelect(input: ReminderInput): void
    onMore(): void
  } = $props()

  const timeZone = localTimeZone()
  const editable = $derived(view.status !== 'legacy' && view.status !== 'error')
  const options = $derived([
    ...(editable && view.status !== 'muted' ? [
      { action: 'hour', label: 'reminder.pauseHour' },
      { action: 'tomorrow', label: 'reminder.pauseTomorrow' },
      { action: 'mute', label: 'reminder.mute' },
    ] : []),
    ...(editable && (view.status === 'muted' || view.status === 'paused') ? [
      { action: 'resume', label: 'reminder.resume' },
    ] : []),
  ])
  let menu: HTMLDivElement
  let x = $state(8)
  let y = $state(8)
  let active = $state(-1)
  let error = $state<MessageKey | null>(null)

  function select(action: string) {
    if (saving || !editable) return
    error = null
    if (action === 'mute') onSelect({ policy: 'muted' })
    else if (action === 'resume') onSelect({ policy: 'enabled' })
    else if (action === 'hour') onSelect({ policy: 'enabled', paused_until: new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') })
    else {
      const result = tomorrowAtNine(new Date(), timeZone)
      if (result.ok) onSelect({ policy: 'enabled', paused_until: result.iso })
      else error = `reminder.validation.${result.reason}`
    }
  }

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
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    let next = active
    if (event.key === 'ArrowDown') next = (active + 1) % rows.length
    else if (event.key === 'ArrowUp') next = active < 0 ? rows.length - 1 : (active - 1 + rows.length) % rows.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = rows.length - 1
    else return
    event.preventDefault()
    active = next
    rows[next]?.focus()
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

<div bind:this={menu} class="reminder-menu menu-panel" role="menu" tabindex="-1"
  aria-label={t('reminder.title', { title: itemTitle })} aria-busy={saving}
  style:left={`${x}px`} style:top={`${y}px`} onkeydown={keydown}>
  <p class="summary">{t(`reminder.status.${view.status}`, { time: view.pausedUntil ? localDateTimeValue(view.pausedUntil, timeZone).replace('T', ' ') : '' })}</p>
  {#each options as option, index}
    <button type="button" class="menu-row" class:active={active === index} role="menuitem"
      tabindex="-1" disabled={saving} onfocus={() => active = index} onpointerenter={() => active = -1}
      onclick={() => select(option.action)}>{t(option.label as MessageKey)}</button>
  {/each}
  {#if options.length}<div class="menu-sep" role="separator"></div>{/if}
  <button type="button" class="menu-row" class:active={active === options.length} role="menuitem"
    tabindex="-1" disabled={saving} onfocus={() => active = options.length} onpointerenter={() => active = -1}
    onclick={() => !saving && onMore()}>{t('reminder.more')}</button>
  {#if error}<p class="summary error" role="alert">{t(error)}</p>{/if}
</div>

<style>
  .reminder-menu { position: fixed; z-index: 30; min-width: 220px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; box-sizing: border-box; }
  .menu-row { width: 100%; min-height: 28px; border: 0; background: none; color: inherit; font: inherit; text-align: left; }
  .menu-row:disabled { opacity: 0.45; }
  .summary { margin: 5px 10px 7px; max-width: 280px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .error { color: var(--danger); }
</style>
