<script lang="ts">
  import { onMount } from 'svelte'
  import { t } from '../lib/strings'

  let { onConfirm, onCancel, returnFocus }: { onConfirm(): void; onCancel(): void; returnFocus?: HTMLElement | null } = $props()
  let dialog: HTMLDivElement

  onMount(() => {
    const previous = returnFocus?.isConnected ? returnFocus
      : document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.focus()
    return () => previous?.focus()
  })

  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onCancel()
    if (event.key !== 'Tab') return
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
    const first = buttons[0]
    const last = buttons.at(-1)!
    if (!buttons.includes(document.activeElement as HTMLButtonElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
</script>

<svelte:window onkeydown={keydown} />
<div class="scrim" role="presentation" onclick={(event) => event.target === event.currentTarget && onCancel()}>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="kickoff-consent-title" tabindex="-1" bind:this={dialog}>
    <h2 id="kickoff-consent-title">{t('kickoff.consentTitle')}</h2>
    <p>{t('kickoff.consentBody')}</p>
    <footer>
      <button type="button" data-consent-cancel onclick={onCancel}>{t('common.cancel')}</button>
      <button type="button" class="primary" data-consent-confirm onclick={onConfirm}>{t('kickoff.consentStart')}</button>
    </footer>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 110; display: grid; place-items: center; padding: 20px; background: #0005; }
  .sheet { width: min(480px, 100%); padding: 24px; box-sizing: border-box; border: 1px solid var(--line); border-radius: 18px; background: var(--sheet); color: var(--fg); box-shadow: 0 24px 80px #0004; }
  h2 { margin: 0; font-size: 19px; }
  p { font-size: 13px; line-height: 1.7; overflow-wrap: anywhere; color: var(--muted-strong); }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 24px; }
  button { padding: 8px 14px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
  .primary { background: var(--accent); border-color: var(--accent); color: white; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
