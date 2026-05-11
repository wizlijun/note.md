<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'

  interface ImportTheme {
    id: string
    name: string
    appearance: 'light' | 'dark'
    source_file: string
    conflict: boolean
  }
  interface ImportError { file: string; message: string }
  interface ImportReport {
    themes: ImportTheme[]
    asset_dirs: string[]
    errors: ImportError[]
    staging_dir: string
  }

  let { report, onClose }: { report: ImportReport; onClose: () => void } = $props()

  let overwrite = $state(false)
  let busy = $state(false)

  const hasConflict = $derived(report.themes.some((t) => t.conflict))
  const canImport = $derived(!busy && report.themes.length > 0 && (!hasConflict || overwrite))

  async function confirm() {
    busy = true
    try {
      const n = await invoke<number>('theme_install', { report, overwrite })
      console.info('[ThemeImport] installed', n, 'themes')
    } catch (e) {
      console.warn('[ThemeImport] install failed:', e)
    } finally {
      busy = false
      onClose()
    }
  }

  async function cancel() {
    busy = true
    try { await invoke('theme_cancel_import', { stagingDir: report.staging_dir }) }
    catch (e) { console.warn('[ThemeImport] cancel:', e) }
    finally { busy = false; onClose() }
  }
</script>

<div class="overlay" role="presentation" onclick={cancel}>
  <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
    <h2>Import Typora theme</h2>

    {#if report.themes.length === 0}
      <p>No Typora themes found in this zip.</p>
    {:else}
      <p>Detected {report.themes.length} theme{report.themes.length === 1 ? '' : 's'}:</p>
      <ul>
        {#each report.themes as t (t.id)}
          <li>
            <strong>{t.name}</strong> ({t.appearance})
            {#if t.conflict}<span class="warn">⚠ will overwrite existing</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}

    {#if report.asset_dirs.length > 0}
      <p>Asset folders:</p>
      <ul>
        {#each report.asset_dirs as d (d)}<li>{d}</li>{/each}
      </ul>
    {/if}

    {#if report.errors.length > 0}
      <p>Errors:</p>
      <ul>
        {#each report.errors as e (e.file)}
          <li class="err">{e.file}: {e.message}</li>
        {/each}
      </ul>
    {/if}

    {#if hasConflict}
      <label class="overwrite">
        <input type="checkbox" checked={overwrite} onchange={(e) => overwrite = (e.currentTarget as HTMLInputElement).checked} />
        Overwrite existing themes
      </label>
    {/if}

    <div class="actions">
      <button onclick={cancel}>Cancel</button>
      <button class="primary" onclick={confirm} disabled={!canImport}>
        {busy ? 'Importing…' : 'Import'}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 200; }
  .dialog { background: Canvas; color: CanvasText; padding: 18px 22px; border-radius: 8px; min-width: 380px; max-width: 560px; max-height: 80vh; overflow: auto; }
  .dialog h2 { margin: 0 0 12px; font-size: 1.05rem; }
  .dialog ul { margin: 6px 0 12px; padding-left: 1.4em; }
  .warn { color: #b8860b; margin-left: 6px; }
  .err  { color: tomato; }
  .overwrite { display: flex; gap: 6px; align-items: center; margin: 10px 0; }
  .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
  .primary { font-weight: 600; }
</style>
