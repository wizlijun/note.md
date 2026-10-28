<script lang="ts">
  import { untrack } from 'svelte'
  import { kickoffCardView, kickoffButtonState, type ButtonStateInput } from '../lib/kickoff/button-state'
  import { formatElapsed } from '../lib/kickoff/status'
  import { t } from '../lib/strings'

  let { itemTitle, input, disabled = false, menuOpen = false, now = Date.now, onClick, onChoose }: {
    itemTitle: string
    input: ButtonStateInput
    disabled?: boolean
    menuOpen?: boolean
    now?: () => number
    onClick(): void
    onChoose?(anchor: HTMLButtonElement): void
  } = $props()

  let currentTime = $state(untrack(() => now()))
  const view = $derived(kickoffCardView(input, currentTime))
  const tooltip = $derived(view.state === 'running'
    ? t('kickoff.steps', { steps: view.steps ?? 0, last: view.last ?? '' })
    : view.durationSeconds !== undefined ? t('kickoff.duration', { time: formatElapsed(view.durationSeconds * 1000) }) : '')

  $effect(() => {
    if (kickoffButtonState(input) !== 'running') return
    currentTime = untrack(() => now())
    const timer = setInterval(() => { currentTime = now() }, 1000)
    return () => clearInterval(timer)
  })
</script>

<span class="kickoff-actions" class:split={Boolean(onChoose) && view.state !== 'running' && view.state !== 'starting'}>
  <button type="button" class="kickoff" data-kickoff-state={view.state}
    disabled={disabled || view.state === 'starting'}
    aria-label={t('kickoff.accessible', { title: itemTitle })} title={tooltip} onclick={onClick}>
    {#if view.state === 'running'}
      <span aria-live="off">⏱ {formatElapsed(view.elapsedMs ?? 0)}</span>
    {:else if view.state === 'starting'}
      {t('kickoff.starting')}
    {:else if view.state === 'idle'}
      {t('kickoff.action')}
    {:else if view.state === 'failed'}
      {t('kickoff.failed')}
    {:else}
      {t('kickoff.view')}
      {#if view.state === 'ready-unread'}<span data-unread aria-hidden="true">●</span>{/if}
      {#if view.state === 'stale'}<small>{t('kickoff.stale')}</small>{/if}
    {/if}
  </button>
  {#if onChoose && view.state !== 'running' && view.state !== 'starting'}
    <button type="button" class="choose" disabled={disabled} aria-label={t('kickoff.choose')} title={t('kickoff.choose')}
      aria-haspopup="menu" aria-expanded={menuOpen}
      onclick={(event) => onChoose?.(event.currentTarget)}
      onkeydown={(event) => {
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !menuOpen) {
          event.preventDefault()
          onChoose?.(event.currentTarget)
        }
      }}><span aria-hidden="true">▾</span></button>
  {/if}
</span>

<style>
  .kickoff-actions { display: inline-flex; flex: none; }
  .split .kickoff { border-radius: 7px 0 0 7px; }
  .split .choose { border-radius: 0 7px 7px 0; border-left: 0; }
  button { border: 1px solid var(--line); border-radius: 7px; background: transparent; color: var(--muted-strong); padding: 6px 8px; font: inherit; font-size: 12px; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--hover); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible { position: relative; z-index: 1; outline: 2px solid var(--accent); outline-offset: 2px; }
  small { margin-left: 5px; color: var(--muted); }
  [data-unread] { color: var(--accent); margin-left: 4px; font-size: 9px; }
</style>
