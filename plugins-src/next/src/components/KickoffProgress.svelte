<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { kickoffCardView, type ButtonStateInput } from '../lib/kickoff/button-state'
  import { formatElapsed } from '../lib/kickoff/status'
  import { t, CATALOGS, type MessageKey } from '../lib/strings'

  let { title, input, hasPrevious = false, now = Date.now, onClose, onRetry, onChoose, onPrevious, returnFocus }: {
    title: string
    input: ButtonStateInput
    hasPrevious?: boolean
    now?: () => number
    returnFocus?: HTMLElement | null
    onClose(): void
    onRetry(): void
    onChoose(): void
    onPrevious(): void
  } = $props()

  let currentTime = $state(untrack(() => now()))
  let dialog: HTMLDivElement
  const view = $derived(kickoffCardView(input, currentTime))
  const failure = $derived(view.failure)
  const failureKey = $derived(`kickoff.failure.${failure?.kind}`)
  const failureLabel = $derived(failureKey in CATALOGS.en ? t(failureKey as MessageKey) : t('kickoff.failure.error'))
  const raw = $derived(failure?.rawSnippet
    ? new TextDecoder().decode(new TextEncoder().encode(failure.rawSnippet).slice(0, 2048), { stream: true }) : '')

  onMount(() => {
    const previous = returnFocus?.isConnected ? returnFocus
      : document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.focus()
    const timer = setInterval(() => { currentTime = now() }, 1000)
    return () => { clearInterval(timer); previous?.focus() }
  })

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onClose()
    if (event.key !== 'Tab') return
    const fields = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), summary')]
    const first = fields[0]
    const last = fields.at(-1)!
    if (!fields.includes(document.activeElement as HTMLElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
</script>

<svelte:window onkeydown={keydown} />
<div class="scrim" role="presentation" onclick={(event) => event.target === event.currentTarget && onClose()}>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="kickoff-progress-title" tabindex="-1" bind:this={dialog}>
    <h2 id="kickoff-progress-title">{title}</h2>
    {#if failure}
      <h3>{failureLabel}</h3>
      {#if failure.message}<p>{Array.from(failure.message).slice(0, 300).join('')}</p>{/if}
      {#if failure.warning}<p class="warning">{failure.warning}</p>{/if}
      {#if failure.kind === 'agent-missing'}<p>{t('kickoff.market')}</p>{/if}
      {#if raw}<details><summary>{t('kickoff.raw')}</summary><pre>{raw}</pre></details>{/if}
      <footer>
        {#if failure.kind !== 'task-changed'}
          <button type="button" onclick={onRetry}>{t('kickoff.retry')}</button>
          <button type="button" onclick={onChoose}>{t('kickoff.choose')}</button>
        {/if}
        {#if hasPrevious}<button type="button" onclick={onPrevious}>{t('kickoff.oldResult')}</button>{/if}
        <button type="button" onclick={onClose}>{t('common.close')}</button>
      </footer>
    {:else}
      <h3>{t('kickoff.progress')}</h3>
      <p>{view.harness}</p>
      <p aria-live="off">⏱ {formatElapsed(view.elapsedMs ?? 0)}</p>
      <p>{t('kickoff.steps', { steps: view.steps ?? 0, last: view.last ?? '' })}</p>
      {#if input.status?.state === 'running' && input.status.warning}<p class="warning">{input.status.warning}</p>{/if}
      <p>{t('kickoff.continues')}</p><p>{t('kickoff.limit')}</p>
      <footer><button type="button" onclick={onClose}>{t('common.close')}</button></footer>
    {/if}
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; padding: 20px; background: #0005; }
  .sheet { width: min(520px, 100%); max-height: calc(100vh - 40px); overflow-y: auto; padding: 24px; box-sizing: border-box; border: 1px solid var(--line); border-radius: 18px; background: var(--sheet); color: var(--fg); box-shadow: 0 24px 80px #0004; }
  h2 { margin: 0; font-size: 19px; }
  h3 { font-size: 14px; }
  p { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
  .warning { color: var(--muted-strong); }
  details { margin: 12px 0; font-size: 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow-y: auto; background: var(--chip); padding: 10px; }
  footer { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
  button { padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); font: inherit; font-size: 12px; cursor: pointer; }
  button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
