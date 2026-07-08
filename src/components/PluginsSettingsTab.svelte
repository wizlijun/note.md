<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'
  import type { PluginManifest } from '../lib/plugins/types'
  import { isPluginEnabled, setPluginEnabled } from '../lib/settings.svelte'
  import { t } from '../lib/i18n/store.svelte'
  import { pluginName, pluginDescription } from '../lib/plugins/plugin-i18n'
  import { sotvaultStore } from '../lib/sotvault.svelte'
  import { evaluateEnabledWhen } from '../lib/plugins/enabled-when'

  type Row = { manifest: PluginManifest; enabled: boolean }

  let rows = $state<Row[]>([])

  onMount(async () => {
    try {
      const all = await invoke<PluginManifest[]>('get_all_plugin_manifests')
      rows = all.map((m) => ({ manifest: m, enabled: isPluginEnabled(m.id) }))
    } catch (e) {
      console.warn('[PluginsSettingsTab] load:', e)
    }
  })

  async function toggle(row: Row, value: boolean) {
    row.enabled = value
    rows = [...rows]
    await setPluginEnabled(row.manifest.id, value)
  }

  function isAvailable(m: PluginManifest): boolean {
    if (!m.available_when) return true
    return evaluateEnabledWhen(m.available_when, {
      currentTab: null,
      settings: {},
      vaultConfigured: sotvaultStore.vaultRoot !== null,
    })
  }
</script>

<div class="plugins-list">
  {#each rows as r (r.manifest.id)}
    {@const avail = isAvailable(r.manifest)}
    <div class="row" class:unavailable={!avail}>
      <label class="head">
        <input type="checkbox" disabled={!avail} checked={avail && r.enabled}
               onchange={(e) => toggle(r, (e.currentTarget as HTMLInputElement).checked)} />
        <span class="name">{pluginName(r.manifest)}</span>
        <span class="version">{r.manifest.version}</span>
        {#if !avail}<span class="needs-vault">{t('plugins.needsVault')}</span>{/if}
      </label>
      {#if pluginDescription(r.manifest)}
        <p class="desc">{pluginDescription(r.manifest)}</p>
      {/if}
      <p class="caps">{t('plugins.capabilities', { caps: r.manifest.host_capabilities.join(', ') })}</p>
    </div>
  {/each}
  {#if rows.length === 0}
    <p class="empty">{t('plugins.none')}</p>
  {/if}
  <p class="restart-note">{t('plugins.restartNote')}</p>
</div>

<style>
  .plugins-list { display: flex; flex-direction: column; gap: 14px; }
  .row {
    padding: 10px 0;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  }
  .row:last-of-type { border-bottom: 0; }
  .head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .name { font-weight: 600; font-size: 13px; flex: 1; }
  .version {
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 55%, transparent);
    font-family: ui-monospace, monospace;
  }
  .desc {
    margin: 4px 0 4px 22px;
    font-size: 12px;
    color: color-mix(in srgb, CanvasText 75%, transparent);
    line-height: 1.4;
  }
  .caps {
    margin: 0 0 0 22px;
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 55%, transparent);
    font-family: ui-monospace, monospace;
  }
  .empty {
    font-size: 12px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
  .restart-note {
    margin-top: 12px;
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
  .needs-vault {
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 55%, transparent);
  }
</style>
