<script lang="ts">
  import type { GuestLink, GuestInfo } from '../../lib/share-guest/types'
  import { parseGuestLink } from '../../lib/share-guest/link'
  import { guestCommand, saveGuestToken } from '../../lib/share-guest/host'
  import { rememberGuest } from '../../lib/share-guest/state.svelte'
  import { openFile } from '../../lib/tabs.svelte'
  import { setActiveView, setSideVisible } from '../../lib/side-panel/registry.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import { modalFocus } from '../../lib/ui/modal-focus'
  let { link, onClose }: { link?: GuestLink; onClose: () => void } = $props()
  let value = $state(''), error = $state(''), busy = $state(false)
  let parsed = $state<GuestLink | undefined>()
  const target = $derived(link ?? parsed)
  function parse() {
    try { parsed = parseGuestLink(value, import.meta.env.DEV); value = ''; error = '' }
    catch { error = t('guest.invalidLink') }
  }
  async function confirm() {
    if (!target || busy) return
    busy = true; error = ''
    const { token, ...publicLink } = target
    try {
      const info = await guestCommand<GuestInfo>('open', publicLink)
      if (token) await saveGuestToken(info.origin, info.project_id, token)
      rememberGuest(info)
      await openFile(info.root + '/' + info.entry)
      await setActiveView('right', 'share-guest'); await setSideVisible('right', true)
      onClose()
    } catch { error = t('guest.downloadFailed') }
    finally { busy = false }
  }
</script>
<div class="overlay" role="presentation">
  <div class="dialog" role="dialog" aria-modal="true" aria-label={t('guest.open')} tabindex="-1" use:modalFocus={{ onClose: () => { if (!busy) onClose() } }}>
    <h2>{t('guest.open')}</h2>
    {#if target}
      <p>{t('guest.confirmDownload', { host: new URL(target.origin).host })}</p>
      {#if !target.token}<p>{t('guest.readOnly')}</p>{/if}
    {:else}
      <label>{t('guest.link')}<input type="password" autocomplete="off" bind:value onkeydown={e => { if(e.key === 'Enter') parse() }} /></label>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <footer><button disabled={busy} onclick={onClose}>{t('guest.cancel')}</button>
      <button disabled={busy || (!target && !value.trim())} onclick={target ? confirm : parse}>{target ? t('guest.download') : t('guest.continue')}</button></footer>
  </div>
</div>
<style>
  .overlay { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: #0006; }
  .dialog { width: min(440px,90vw); padding: 24px; border-radius: 12px; background: var(--bg,white); color: var(--fg,#222); box-shadow: 0 12px 40px #0004; }
  h2 { margin-top: 0; font-size: 18px; } label { display: grid; gap: 8px; } input { width: 100%; box-sizing: border-box; }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; } p { overflow-wrap: anywhere; }
</style>
