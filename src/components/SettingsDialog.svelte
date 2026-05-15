<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'
  import { ask } from '@tauri-apps/plugin-dialog'
  import { settings, saveSettings, getPluginScopedAll, mergePluginScoped } from '../lib/settings.svelte'
  import { platform } from '../lib/platform.svelte'
  let isIOSPlatform = $state(false)
  $effect(() => {
    platform().then((p) => { isIOSPlatform = p === 'ios' })
  })
  import { SKINS, skin, setSkin, type SkinId, isValidSkinId } from '../lib/skin.svelte'
  import { collectSettingsTabs, type SettingsTab } from '../lib/plugins/settings-registry'
  import type { PluginManifest } from '../lib/plugins/types'
  import PluginsSettingsTab from './PluginsSettingsTab.svelte'
  import VaultSettingsTab from './VaultSettingsTab.svelte'

  let { open = $bindable(false) }: { open: boolean } = $props()

  let pluginTabs = $state<SettingsTab[]>([])
  let selectedTab = $state<'plugins' | 'core' | string>('core')
  let pluginValues = $state<Record<string, Record<string, unknown>>>({})

  onMount(async () => {
    try {
      const manifests = await invoke<PluginManifest[]>('get_plugin_manifests')
      pluginTabs = collectSettingsTabs(manifests)
      for (const tab of pluginTabs) {
        const all = getPluginScopedAll(tab.pluginId)
        // Strip the `<id>.` prefix for form binding.
        const stripped: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(all)) {
          stripped[k.slice(tab.pluginId.length + 1)] = v
        }
        pluginValues[tab.pluginId] = stripped
      }
    } catch (e) {
      console.warn('[SettingsDialog] manifest load:', e)
    }
  })

  async function savePluginField(pluginId: string, key: string, value: unknown) {
    pluginValues[pluginId] = { ...(pluginValues[pluginId] ?? {}), [key]: value }
    await mergePluginScoped({ [`${pluginId}.${key}`]: value })
  }

  // The 22 categories cover every extension our editor supports as a document type.
  // These must match the `fileAssociations` in src-tauri/tauri.conf.json — that's
  // what tells macOS that M↓ is a legitimate handler for these UTIs in the first place.
  const FILE_GROUPS: { label: string; exts: string[] }[] = [
    { label: 'Markdown',      exts: ['md', 'markdown', 'mdown', 'mkd'] },
    { label: 'HTML',          exts: ['html', 'htm'] },
    { label: 'Plain text',    exts: ['txt', 'log', 'csv', 'tsv', 'env'] },
    { label: 'JSON',          exts: ['json', 'jsonc'] },
    { label: 'YAML',          exts: ['yaml', 'yml'] },
    { label: 'Config',        exts: ['toml', 'ini', 'conf'] },
    { label: 'XML',           exts: ['xml'] },
    { label: 'Shell script',  exts: ['sh', 'bash', 'zsh'] },
    { label: 'Python',        exts: ['py'] },
    { label: 'JavaScript',    exts: ['js', 'mjs', 'cjs', 'jsx'] },
    { label: 'TypeScript',    exts: ['ts', 'tsx'] },
    { label: 'Rust',          exts: ['rs'] },
    { label: 'Go',            exts: ['go'] },
    { label: 'Java',          exts: ['java'] },
    { label: 'C / C++',       exts: ['c', 'cpp', 'cc', 'h', 'hpp'] },
    { label: 'Ruby',          exts: ['rb'] },
    { label: 'Swift',         exts: ['swift'] },
    { label: 'Kotlin',        exts: ['kt'] },
    { label: 'PHP',           exts: ['php'] },
    { label: 'C#',            exts: ['cs'] },
    { label: 'CSS',           exts: ['css', 'scss'] },
    { label: 'SQL',           exts: ['sql'] },
  ]
  const ALL_EXTS = FILE_GROUPS.flatMap((g) => g.exts)

  type ExtResult = {
    ext: string
    uti: string | null
    ok: boolean
    error: string | null
  }

  let busy = $state(false)
  let resultText = $state<string | null>(null)
  let resultDetails = $state<ExtResult[] | null>(null)

  async function handleSetDefault() {
    const ok = await ask(
      `This will register M↓ as the macOS default application for ${ALL_EXTS.length} ` +
        `file extensions across ${FILE_GROUPS.length} categories.\n\n` +
        `From then on, double-clicking any of these file types in Finder will open them in M↓ instead of your current default editor.\n\n` +
        `Categories: ${FILE_GROUPS.map((g) => g.label).join(', ')}.\n\n` +
        `You can revert this for any single type later: in Finder, select a file → Get Info → "Open with" → choose another app → click "Change All…".\n\n` +
        `Continue?`,
      {
        title: 'Set M↓ as default for text & code files',
        kind: 'warning',
        okLabel: 'Set as default',
        cancelLabel: 'Cancel',
      },
    )
    if (!ok) return
    busy = true
    resultText = null
    resultDetails = null
    try {
      const results = await invoke<ExtResult[]>('set_default_app_for_extensions', {
        exts: ALL_EXTS,
      })
      resultDetails = results
      const successes = results.filter((r) => r.ok).length
      const failures = results.filter((r) => !r.ok)
      if (failures.length === 0) {
        resultText = `Done — M↓ is now the default for all ${successes} extensions.`
      } else {
        resultText =
          `Set ${successes}/${results.length} extensions. ` +
          `Failed: ${failures.map((f) => `.${f.ext}`).join(', ')} ` +
          `(macOS may not have a registered UTI for these — they will still open in M↓ when launched explicitly).`
      }
    } catch (e) {
      resultText = `Error: ${e instanceof Error ? e.message : String(e)}`
    } finally {
      busy = false
    }
  }

  async function onToggle(e: Event) {
    settings.autoSave = (e.currentTarget as HTMLInputElement).checked
    await saveSettings()
  }

  async function onSkinChange(e: Event) {
    const val = (e.currentTarget as HTMLSelectElement).value
    if (!isValidSkinId(val)) return
    setSkin(val)
    settings.skin = val
    await saveSettings()
  }

  function describeSkin(id: SkinId): string {
    return SKINS.find((s) => s.id === id)?.description ?? ''
  }
</script>

{#if open}
  <div
    class="overlay"
    role="presentation"
    onclick={() => (open = false)}
    onkeydown={(e) => e.key === 'Escape' && (open = false)}
  >
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => e.stopPropagation()}>
      <h2>Preferences</h2>

      <nav class="tab-strip">
        {#if !isIOSPlatform}
          <button class:active={selectedTab === 'plugins'} onclick={() => selectedTab = 'plugins'}>Plugins</button>
        {/if}
        <button class:active={selectedTab === 'core'} onclick={() => selectedTab = 'core'}>Core</button>
        {#if isIOSPlatform}
          <button class:active={selectedTab === 'vault'} onclick={() => selectedTab = 'vault'}>Vault</button>
        {/if}
        {#each pluginTabs as t (t.pluginId)}
          <button class:active={selectedTab === t.pluginId} onclick={() => selectedTab = t.pluginId}>{t.label}</button>
        {/each}
      </nav>

      {#if !isIOSPlatform && selectedTab === 'plugins'}
        <PluginsSettingsTab />
      {:else if selectedTab === 'core'}
        <section class="block">
          <label class="row">
            <span class="lbl">Skin</span>
            <select value={skin.current} onchange={onSkinChange}>
              {#each SKINS as s (s.id)}
                <option value={s.id}>{s.label}</option>
              {/each}
            </select>
          </label>
          <p class="desc">{describeSkin(skin.current)}</p>
        </section>

        <section class="block">
          <label class="row">
            <input type="checkbox" checked={settings.autoSave} onchange={onToggle} />
            Enable auto-save (writes after 800 ms idle)
          </label>
        </section>

        {#if !isIOSPlatform}
          <section class="block">
            <h3>Default app for text &amp; code files</h3>
            <p class="desc">
              Make M↓ the default macOS application for opening text and source code files.
              Once set, double-clicking any of the supported file types in Finder (or selecting
              <em>Open With…</em>) will launch M↓.
            </p>
            <p class="desc">
              This affects <strong>{ALL_EXTS.length}</strong> file extensions across
              <strong>{FILE_GROUPS.length}</strong> categories. Every change goes through macOS Launch
              Services, so the system, Finder, and other apps all pick it up immediately.
            </p>
            <details class="ext-list">
              <summary>Show affected file types ({ALL_EXTS.length} extensions)</summary>
              <ul>
                {#each FILE_GROUPS as g}
                  <li><strong>{g.label}</strong> — {g.exts.map((e) => `.${e}`).join(', ')}</li>
                {/each}
              </ul>
            </details>
            <button class="primary" onclick={handleSetDefault} disabled={busy}>
              {busy ? 'Setting…' : `Set M↓ as default for all ${ALL_EXTS.length} types`}
            </button>
            {#if resultText}
              <p
                class="result"
                class:ok={resultDetails?.every((r) => r.ok)}
                class:partial={resultDetails && resultDetails.some((r) => !r.ok) && resultDetails.some((r) => r.ok)}
                class:fail={resultDetails && resultDetails.every((r) => !r.ok)}
              >
                {resultText}
              </p>
            {/if}
            <p class="undo-note">
              <strong>To undo for one file type:</strong> in Finder, select a file → File menu →
              <em>Get Info</em> → <em>Open with</em> section → pick another app → click
              <em>Change All…</em>. There's no way to bulk-undo through macOS, so make sure you want this
              before clicking the button above.
            </p>
          </section>
        {/if}
      {:else if selectedTab === 'vault' && isIOSPlatform}
        <VaultSettingsTab />
      {:else}
        {#each pluginTabs as t (t.pluginId)}
          {#if selectedTab === t.pluginId}
            <div class="plugin-settings">
              {#each t.schema as field (field.key)}
                {@const localKey = field.key.slice(t.pluginId.length + 1)}
                <label class="plugin-field">
                  <span class="lbl">{field.label}</span>
                  {#if field.type === 'string'}
                    <input type="text"
                      value={(pluginValues[t.pluginId]?.[localKey] as string) ?? field.default ?? ''}
                      placeholder={field.placeholder ?? ''}
                      onchange={(e) => savePluginField(t.pluginId, localKey, (e.currentTarget as HTMLInputElement).value)} />
                  {:else if field.type === 'secret'}
                    <input type="password"
                      value={(pluginValues[t.pluginId]?.[localKey] as string) ?? ''}
                      onchange={(e) => savePluginField(t.pluginId, localKey, (e.currentTarget as HTMLInputElement).value)} />
                  {:else if field.type === 'select'}
                    <select
                      value={(pluginValues[t.pluginId]?.[localKey] as string) ?? field.default ?? ''}
                      onchange={(e) => savePluginField(t.pluginId, localKey, (e.currentTarget as HTMLSelectElement).value)}>
                      {#each field.options as opt}
                        <option value={opt}>{opt}</option>
                      {/each}
                    </select>
                  {:else if field.type === 'boolean'}
                    <input type="checkbox"
                      checked={(pluginValues[t.pluginId]?.[localKey] as boolean) ?? field.default ?? false}
                      onchange={(e) => savePluginField(t.pluginId, localKey, (e.currentTarget as HTMLInputElement).checked)} />
                  {/if}
                </label>
              {/each}
            </div>
          {/if}
        {/each}
      {/if}

      <div class="actions">
        <button onclick={() => (open = false)}>Done</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.3);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
  }
  .dialog {
    width: min(560px, 92vw);
    max-height: 86vh;
    overflow: auto;
    background: Canvas;
    color: CanvasText;
    border: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    border-radius: 8px;
    padding: 18px 20px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.25);
  }
  h2 { margin: 0 0 12px 0; font-size: 16px; }
  h3 {
    margin: 0 0 8px 0;
    font-size: 13px;
    font-weight: 600;
  }
  .block {
    padding: 12px 0;
    border-top: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  .block:first-of-type { border-top: 0; padding-top: 0; }
  .row { display: flex; gap: 8px; align-items: center; font-size: 13px; }
  .row .lbl {
    width: 60px;
    flex-shrink: 0;
  }
  .row select {
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    font-size: 13px;
    flex: 1;
    max-width: 240px;
  }
  .desc {
    font-size: 12px;
    line-height: 1.5;
    margin: 0 0 8px 0;
    color: color-mix(in srgb, CanvasText 75%, transparent);
  }
  .ext-list {
    margin: 8px 0;
    font-size: 12px;
  }
  .ext-list summary {
    cursor: pointer;
    color: color-mix(in srgb, CanvasText 65%, transparent);
    user-select: none;
  }
  .ext-list ul {
    margin: 8px 0 0 0;
    padding-left: 18px;
    line-height: 1.7;
    color: color-mix(in srgb, CanvasText 80%, transparent);
  }
  .ext-list li { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
  .ext-list li strong { font-family: -apple-system, system-ui, sans-serif; font-size: 12px; }
  .actions { display: flex; justify-content: flex-end; margin-top: 16px; }
  button {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    cursor: pointer;
    font-size: 12px;
  }
  button:disabled { opacity: 0.5; cursor: progress; }
  .primary {
    background: AccentColor;
    color: AccentColorText;
    border-color: AccentColor;
    font-weight: 500;
  }
  .result {
    margin: 10px 0 0 0;
    padding: 8px 10px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.45;
    background: color-mix(in srgb, CanvasText 8%, transparent);
  }
  .result.ok {
    background: color-mix(in srgb, #2ea043 18%, transparent);
    color: color-mix(in srgb, #2ea043 90%, CanvasText);
  }
  .result.partial {
    background: color-mix(in srgb, #d29922 22%, transparent);
  }
  .result.fail {
    background: color-mix(in srgb, #cf222e 18%, transparent);
  }
  .undo-note {
    margin: 10px 0 0 0;
    font-size: 11px;
    line-height: 1.5;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
  .tab-strip {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    margin-bottom: 12px;
  }
  .tab-strip button {
    background: transparent;
    border: 0;
    padding: 8px 12px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    font-size: 12px;
    color: CanvasText;
    border-radius: 0;
  }
  .tab-strip button.active {
    border-bottom-color: AccentColor;
    font-weight: 600;
  }
  .plugin-settings { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
  .plugin-field { display: flex; align-items: center; gap: 12px; font-size: 13px; }
  .plugin-field .lbl { width: 160px; flex-shrink: 0; }
  .plugin-field input[type="text"],
  .plugin-field input[type="password"],
  .plugin-field select {
    flex: 1;
    padding: 6px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    font-size: 12px;
  }
</style>
