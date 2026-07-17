<!-- src/components/market/ConsentModal.svelte — install-time capability consent
     (子项目③ / ②安全评审 V1). Before installing, `plugin_market_preview` runs
     the FULL verify pipeline (download → sha256 → minisign) on a throwaway copy
     and returns the verified manifest. We render that manifest's `capabilities`
     (a Vec<String> on ManifestV2 — NOT host_capabilities) so the user consents
     to exactly what passed verification. Only on "Trust & Install" do we call
     `plugin_market_install`. -->
<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { t } from '../../lib/i18n/store.svelte'
  import { capabilityLabel, isSensitiveCapability } from '../../lib/market/types'

  interface Props {
    id: string
    version: string
    name: string
    /** Resolves after a successful install so the parent can re-fetch lists. */
    onInstalled: () => void
    onClose: () => void
  }
  let { id, version, name, onInstalled, onClose }: Props = $props()

  // Preview manifest returned by plugin_market_preview (verified, not installed).
  interface PreviewManifest {
    id: string
    name: string
    version: string
    description?: string | null
    capabilities?: string[]
  }

  let loading = $state(true)
  let installing = $state(false)
  let error = $state<string | null>(null)
  let manifest = $state<PreviewManifest | null>(null)

  // Capabilities sorted so sensitive ones surface first.
  let caps = $derived<string[]>(
    [...(manifest?.capabilities ?? [])].sort((a, b) => {
      const sa = isSensitiveCapability(a) ? 0 : 1
      const sb = isSensitiveCapability(b) ? 0 : 1
      return sa - sb
    }),
  )

  $effect(() => {
    void preview()
  })

  async function preview() {
    loading = true
    error = null
    try {
      manifest = await invoke<PreviewManifest>('plugin_market_preview', { id, version })
    } catch (e) {
      error = String(e)
    } finally {
      loading = false
    }
  }

  async function confirmInstall() {
    installing = true
    error = null
    try {
      await invoke('plugin_market_install', { id, version })
      onInstalled()
    } catch (e) {
      error = String(e)
      installing = false
    }
  }
</script>

<div class="overlay" role="presentation" onclick={() => !installing && onClose()}
     onkeydown={(e) => e.key === 'Escape' && !installing && onClose()}>
  <div class="modal" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
    <h2>{t('pluginMarket.consent.title', { name: manifest?.name ?? name })}</h2>
    <p class="ver">{id} · {version}</p>

    {#if loading}
      <p class="msg">{t('pluginMarket.consent.verifying')}</p>
    {:else if error}
      <p class="msg error">{error}</p>
    {:else}
      {#if manifest?.description}
        <p class="desc">{manifest.description}</p>
      {/if}
      <p class="intro">{t('pluginMarket.consent.intro')}</p>
      {#if caps.length === 0}
        <p class="none">{t('pluginMarket.consent.none')}</p>
      {:else}
        <ul class="caps">
          {#each caps as cap (cap)}
            <li class:sensitive={isSensitiveCapability(cap)}>
              <span class="dot" aria-hidden="true"></span>
              <span class="label">{capabilityLabel(cap)}</span>
              {#if isSensitiveCapability(cap)}
                <span class="warn-tag">{t('pluginMarket.consent.sensitive')}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    <div class="actions">
      <button class="ghost" onclick={onClose} disabled={installing}>{t('pluginMarket.cancel')}</button>
      <button class="primary" onclick={confirmInstall} disabled={loading || installing || !!error}>
        {installing ? t('pluginMarket.installing') : t('pluginMarket.consent.trustInstall')}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; z-index: 100;
    background: color-mix(in srgb, CanvasText 40%, transparent);
    display: flex; align-items: center; justify-content: center; padding: 20px;
  }
  .modal {
    background: Canvas; color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
    border-radius: 12px; padding: 20px 22px; width: min(460px, 100%);
    max-height: 82vh; overflow: auto; box-shadow: 0 12px 40px rgba(0,0,0,0.28);
  }
  h2 { margin: 0 0 2px; font-size: 15px; }
  .ver { margin: 0 0 12px; font-size: 11px; font-family: ui-monospace, monospace;
    color: color-mix(in srgb, CanvasText 55%, transparent); }
  .desc { margin: 0 0 10px; font-size: 12px; line-height: 1.45;
    color: color-mix(in srgb, CanvasText 78%, transparent); }
  .intro { margin: 0 0 8px; font-size: 12px;
    color: color-mix(in srgb, CanvasText 70%, transparent); }
  .msg { font-size: 13px; padding: 10px 0; }
  .msg.error { color: #d24; }
  .none { font-size: 12px; color: color-mix(in srgb, CanvasText 55%, transparent); }
  .caps { list-style: none; margin: 0 0 4px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .caps li {
    display: flex; align-items: center; gap: 8px; font-size: 12.5px;
    padding: 6px 8px; border-radius: 6px;
    background: color-mix(in srgb, CanvasText 5%, transparent);
  }
  .caps li.sensitive {
    background: color-mix(in srgb, #e0a800 16%, transparent);
    color: color-mix(in srgb, CanvasText 92%, transparent);
  }
  .dot { width: 6px; height: 6px; border-radius: 50%;
    background: color-mix(in srgb, CanvasText 45%, transparent); flex: 0 0 auto; }
  .caps li.sensitive .dot { background: #e0a800; }
  .label { flex: 1; }
  .warn-tag {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px;
    padding: 1px 6px; border-radius: 999px; font-weight: 600;
    background: #e0a800; color: #1a1400;
  }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  button {
    font-size: 12.5px; padding: 6px 14px; border-radius: 7px; cursor: pointer;
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    background: color-mix(in srgb, CanvasText 6%, transparent); color: CanvasText;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary {
    background: color-mix(in srgb, #2f7bd6 90%, CanvasText); color: white;
    border-color: transparent; font-weight: 600;
  }
</style>
