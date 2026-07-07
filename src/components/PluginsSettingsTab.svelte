<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'
  import type { PluginManifest } from '../lib/plugins/types'
  import { isPluginEnabled, setPluginEnabled } from '../lib/settings.svelte'
  import { t } from '../lib/i18n/store.svelte'

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
</script>

<div class="plugins-list">
  {#each rows as r (r.manifest.id)}
    <div class="row">
      <label class="head">
        <input type="checkbox" checked={r.enabled}
               onchange={(e) => toggle(r, (e.currentTarget as HTMLInputElement).checked)} />
        <span class="name">{r.manifest.name}</span>
        <span class="version">{r.manifest.version}</span>
      </label>
      {#if r.manifest.description}
        <p class="desc">{r.manifest.description}</p>
      {/if}
      <p class="caps">Capabilities: {r.manifest.host_capabilities.join(', ')}</p>
    </div>
  {/each}
  {#if rows.length === 0}
    <p class="empty">No plugins detected.</p>
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
</style>
