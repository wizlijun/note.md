<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'
  import type { PluginManifest } from '../lib/plugins/types'
  import { isPluginEnabled, setPluginEnabled } from '../lib/settings.svelte'

  type Row = { manifest: PluginManifest; enabled: boolean; builtin?: boolean }

  // Built-in features that are managed through the same `plugins.enabled` map
  // as external plugins, but ship inside the app (no on-disk manifest / binary).
  const BUILTIN_MANIFESTS: PluginManifest[] = [
    {
      id: 'folder-view',
      name: 'Folder View',
      version: '',
      binary: '',
      description: '在左侧以树形显示当前文件所在目录，可浏览并打开文件。',
      host_capabilities: [],
    },
  ]

  let rows = $state<Row[]>([])

  onMount(async () => {
    const builtinRows: Row[] = BUILTIN_MANIFESTS.map((m) => ({
      manifest: m,
      enabled: isPluginEnabled(m.id),
      builtin: true,
    }))
    try {
      const all = await invoke<PluginManifest[]>('get_all_plugin_manifests')
      rows = [...builtinRows, ...all.map((m) => ({ manifest: m, enabled: isPluginEnabled(m.id) }))]
    } catch (e) {
      console.warn('[PluginsSettingsTab] load:', e)
      rows = builtinRows
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
        {#if r.builtin}
          <span class="badge">内建</span>
        {:else}
          <span class="version">{r.manifest.version}</span>
        {/if}
      </label>
      {#if r.manifest.description}
        <p class="desc">{r.manifest.description}</p>
      {/if}
      {#if !r.builtin}
        <p class="caps">Capabilities: {r.manifest.host_capabilities.join(', ')}</p>
      {/if}
    </div>
  {/each}
  {#if rows.length === 0}
    <p class="empty">No plugins detected.</p>
  {/if}
  <p class="restart-note">改动需要重启 M↓ 后生效</p>
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
  .badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, CanvasText 12%, transparent);
    color: color-mix(in srgb, CanvasText 65%, transparent);
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
