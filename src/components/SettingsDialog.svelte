<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'
  import { ask, open as openFilePicker } from '@tauri-apps/plugin-dialog'
  import { settings, saveSettings, getPluginScopedAll, mergePluginScoped, pluginScopedVersion } from '../lib/settings.svelte'
  import {
    updater as updaterState, runCheck as updaterRunCheck, setCheckOnStartup,
    downloadAndInstall as updaterDownloadAndInstall, restartApp as updaterRestart,
    hasUpdateForSettings,
  } from '../lib/updater.svelte'
  import { themes, loadThemes, reloadThemes } from '../lib/themes.svelte'
  import { pendingThemeImport } from '../lib/theme-import-bus.svelte'
  import ThemeImportDialog from './ThemeImportDialog.svelte'
  import { platform } from '../lib/platform.svelte'
  import { collectSettingsTabs, type SettingsTab } from '../lib/plugins/settings-registry'
  import type { PluginManifest } from '../lib/plugins/types'
  import { isPluginActive } from '../lib/plugins/registry'
  import PluginsSettingsTab from './PluginsSettingsTab.svelte'
  import VaultSettingsTab from './VaultSettingsTab.svelte'
  import OpenClawSettingsTab from './OpenClawSettingsTab.svelte'
  import OpenClawDevicesTab from './OpenClawDevicesTab.svelte'

  let { open = $bindable(false) }: { open: boolean } = $props()

  let isIOSPlatform = $state(false)
  $effect(() => {
    platform().then((p) => { isIOSPlatform = p === 'ios' })
  })

  let pluginTabs = $state<SettingsTab[]>([])
  let selectedTab = $state<'plugins' | 'core' | string>('core')
  let pluginValues = $state<Record<string, Record<string, unknown>>>({})

  type CliStatus = { installed: boolean; path: string | null; target_valid: boolean }
  let cliStatus = $state<CliStatus | null>(null)
  let cliBusy = $state(false)
  let cliError = $state<string | null>(null)

  let updaterBusy = $state(false)
  let updaterMessage = $state<string | null>(null)

  async function handleCheckUpdate() {
    updaterBusy = true
    updaterMessage = null
    try {
      await updaterRunCheck({ forceFresh: true })
      if (updaterState.state === 'uptodate') {
        updaterMessage = '已是最新版本。'
      } else if (updaterState.state === 'available') {
        updaterMessage = `发现新版本 v${updaterState.latestVersion}`
      }
    } catch (e) {
      updaterMessage = e instanceof Error ? e.message : String(e)
    } finally {
      updaterBusy = false
    }
  }

  async function handleUpdateNow() {
    updaterBusy = true
    updaterMessage = null
    try {
      await updaterDownloadAndInstall()
    } catch (e) {
      updaterMessage = e instanceof Error ? e.message : String(e)
    } finally {
      updaterBusy = false
    }
  }

  async function handleRestart() {
    try {
      await updaterRestart()
    } catch (e) {
      updaterMessage = e instanceof Error ? e.message : String(e)
    }
  }

  async function onCheckOnStartupToggle(e: Event) {
    await setCheckOnStartup((e.currentTarget as HTMLInputElement).checked)
  }

  function formatLastChecked(iso: string | null): string {
    if (!iso) return '从未'
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return iso
    const d = new Date(t)
    return d.toLocaleString()
  }

  async function refreshCliStatus() {
    try {
      cliStatus = await invoke<CliStatus>('cli_install_status')
    } catch (e) {
      console.warn('[SettingsDialog] cli_install_status:', e)
      cliStatus = { installed: false, path: null, target_valid: false }
    }
  }

  async function handleCliInstall() {
    cliBusy = true
    cliError = null
    try {
      const candidates = await invoke<string[]>('cli_install_candidates')
      const { ask } = await import('@tauri-apps/plugin-dialog')
      for (const dir of candidates) {
        const ok = await ask(`Install 'mdedit' into ${dir}?`, {
          title: "Install 'mdedit' Command",
          kind: 'info',
        })
        if (ok) {
          await invoke('cli_install', { dir })
          break
        }
      }
    } catch (e) {
      cliError = e instanceof Error ? e.message : String(e)
    } finally {
      cliBusy = false
      await refreshCliStatus()
    }
  }

  async function handleCliUninstall() {
    if (!cliStatus?.installed || !cliStatus.path) return
    cliBusy = true
    cliError = null
    try {
      const dir = cliStatus.path.replace(/\/mdedit$/, '')
      await invoke('cli_uninstall', { dir })
    } catch (e) {
      cliError = e instanceof Error ? e.message : String(e)
    } finally {
      cliBusy = false
      await refreshCliStatus()
    }
  }

  onMount(async () => {
    try {
      const manifests = await invoke<PluginManifest[]>('get_plugin_manifests')
      pluginTabs = collectSettingsTabs(manifests)
    } catch (e) {
      console.warn('[SettingsDialog] manifest load:', e)
    }
    void refreshCliStatus()
  })

  $effect(() => {
    void pluginScopedVersion.value
    if (!open || pluginTabs.length === 0) return
    for (const tab of pluginTabs) {
      const all = getPluginScopedAll(tab.pluginId)
      const stripped: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(all)) {
        stripped[k.slice(tab.pluginId.length + 1)] = v
      }
      pluginValues[tab.pluginId] = stripped
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

  let importReport = $state<unknown | null>(null)
  let importBusy = $state(false)

  // Mirror the App.svelte drag-drop bus: when a .zip is dropped, App stuffs
  // the prepared ImportReport into pendingThemeImport.report; we surface it
  // here so the ThemeImportDialog modal renders.
  $effect(() => {
    if (pendingThemeImport.report) {
      importReport = pendingThemeImport.report
      pendingThemeImport.report = null
    }
  })

  async function onLightThemeChange(e: Event) {
    settings.theme.light = (e.currentTarget as HTMLSelectElement).value
    await saveSettings()
  }
  async function onDarkThemeChange(e: Event) {
    settings.theme.dark = (e.currentTarget as HTMLSelectElement).value
    await saveSettings()
  }
  async function onFollowSystemToggle(e: Event) {
    settings.theme.followSystem = !(e.currentTarget as HTMLInputElement).checked
    // Note: the *checkbox label* says "Always use light theme", so
    // checked means !followSystem.
    await saveSettings()
  }

  async function handleImportTheme() {
    const selection = await openFilePicker({
      multiple: false,
      directory: false,
      filters: [{ name: 'Typora theme zip', extensions: ['zip'] }],
    })
    if (!selection || Array.isArray(selection)) return
    importBusy = true
    try {
      importReport = await invoke('theme_import', { zipPath: selection })
    } catch (e) {
      console.warn('[Settings] theme_import:', e)
      importReport = { themes: [], asset_dirs: [], errors: [{ file: '?', message: String(e) }], staging_dir: '' }
    } finally {
      importBusy = false
    }
  }

  async function handleRevealThemes() {
    try { await invoke('theme_reveal') }
    catch (e) { console.warn('[Settings] theme_reveal:', e) }
  }

  async function handleReloadThemes() {
    await reloadThemes()
  }

  async function handleRestoreBuiltins() {
    try { await invoke('theme_restore_builtins') }
    catch (e) { console.warn('[Settings] theme_restore_builtins:', e) }
    await reloadThemes()
  }

  $effect(() => { void loadThemes() })
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
        <button class:active={selectedTab === 'block'} onclick={() => selectedTab = 'block'}>Block</button>
        {#if !isIOSPlatform}
          <button class:active={selectedTab === 'cli'} onclick={() => { selectedTab = 'cli'; void refreshCliStatus() }}>CLI</button>
          <button class:active={selectedTab === 'updates'} onclick={() => { selectedTab = 'updates' }}>Updates</button>
        {/if}
        {#if isIOSPlatform}
          <button class:active={selectedTab === 'vault'} onclick={() => selectedTab = 'vault'}>Vault</button>
        {/if}
        {#if isPluginActive('openclaw-chat')}
          <button class:active={selectedTab === 'openclaw'} onclick={() => selectedTab = 'openclaw'}>OpenClaw</button>
        {/if}
        {#each pluginTabs as t (t.pluginId)}
          <button class:active={selectedTab === t.pluginId} onclick={() => selectedTab = t.pluginId}>{t.label}</button>
        {/each}
      </nav>

      {#if !isIOSPlatform && selectedTab === 'plugins'}
        <PluginsSettingsTab />
      {:else if selectedTab === 'core'}
        <section class="block">
          <h3>Themes</h3>
          <label class="row">
            <span class="lbl">Light theme</span>
            <select value={settings.theme.light} onchange={onLightThemeChange}>
              {#each themes.list as t (t.id)}
                <option value={t.id}>{t.name}</option>
              {/each}
            </select>
          </label>
          <label class="row">
            <span class="lbl">Dark theme</span>
            <select value={settings.theme.dark} onchange={onDarkThemeChange}>
              {#each themes.list as t (t.id)}
                <option value={t.id}>{t.name}</option>
              {/each}
            </select>
          </label>
          <label class="row" style="margin-top: 6px;">
            <input
              type="checkbox"
              checked={!settings.theme.followSystem}
              onchange={onFollowSystemToggle}
            />
            Always use light theme (ignore system appearance)
          </label>
          <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 8px;">
            <button onclick={handleImportTheme} disabled={importBusy}>
              {importBusy ? 'Importing…' : 'Import Typora theme…'}
            </button>
            <button onclick={handleRevealThemes}>Reveal themes folder</button>
            <button onclick={handleReloadThemes}>Reload themes</button>
            <button onclick={handleRestoreBuiltins}>Restore built-in themes</button>
          </div>
          {#if themes.error}
            <p class="desc" style="color: tomato;">Failed to load themes: {themes.error}</p>
          {/if}
        </section>

        {#if importReport}
          <ThemeImportDialog
            report={importReport as never}
            onClose={() => { importReport = null; reloadThemes() }}
          />
        {/if}

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
      {:else if selectedTab === 'block'}
        <section class="block">
          <label class="row">
            <input type="checkbox" bind:checked={settings.mdblock.enabled} onchange={() => saveSettings()} />
            Enable Block IDs (mdblock)
          </label>
          <p class="desc">
            Assigns stable ids to every block in markdown documents so AI tools can cite passages
            with sub-page precision. Run <strong>Compute Blocks</strong> on a document to opt it in.
          </p>
        </section>

        <section class="block">
          <p class="desc">
            <strong>Saving the .md file</strong> automatically persists the matching
            <code>.block.yaml</code> in the cache. While editing, block markers
            update in-memory in real time; the file write happens on save.
          </p>
          <label class="row">
            <input type="checkbox"
                   bind:checked={settings.mdblock.injectAiHint}
                   disabled={!settings.mdblock.enabled}
                   onchange={() => saveSettings()} />
            Inject AI usage hint into <code>.block.md</code>
          </label>
        </section>

        <section class="block">
          <h3>Chunking strategy</h3>
          <label class="row">
            <span class="lbl">Strategy</span>
            <select bind:value={settings.mdblock.chunkStrategy}
                    disabled={!settings.mdblock.enabled}
                    onchange={() => saveSettings()}>
              <option value="section">Section-first (cut at headings; recommended)</option>
              <option value="size">Size-first (qmd-style; cut anywhere structural)</option>
            </select>
          </label>
          <p class="desc">
            <strong>Section-first</strong> cuts at H2 boundaries by default; oversized sections
            are split at deeper headings; tiny sections are merged with neighbors.
            Each block stays a self-contained semantic unit (one chapter / sub-section),
            ideal for selecting + sending to an LLM for revision.
          </p>
          <label class="row" style:opacity={settings.mdblock.chunkStrategy === 'section' ? 1 : 0.5}>
            <span class="lbl">Section cut level</span>
            <select bind:value={settings.mdblock.sectionCutLevel}
                    disabled={!settings.mdblock.enabled || settings.mdblock.chunkStrategy !== 'section'}
                    onchange={() => saveSettings()}>
              <option value={1}>H1 (one block per top-level chapter)</option>
              <option value={2}>H2 (one block per chapter; default)</option>
              <option value={3}>H3 (one block per sub-section)</option>
            </select>
          </label>
          <label class="row" style:opacity={settings.mdblock.chunkStrategy === 'section' ? 1 : 0.5}>
            <span class="lbl">Min section chars (merge below)</span>
            <input type="number" min="0" max="5000" step="50"
                   bind:value={settings.mdblock.sectionMinChars}
                   disabled={!settings.mdblock.enabled || settings.mdblock.chunkStrategy !== 'section'}
                   onchange={() => saveSettings()} />
          </label>
          <label class="row">
            <span class="lbl">Max chars per block</span>
            <input type="number" min="200" max="20000" step="100"
                   bind:value={settings.mdblock.chunkSizeChars}
                   disabled={!settings.mdblock.enabled}
                   onchange={() => saveSettings()} />
          </label>
          <p class="desc">
            For section-first: oversized sections get split at deeper headings (or by size as a last resort).
            For size-first: this is the per-chunk target.
          </p>
          <label class="row">
            <span class="lbl">Similarity threshold (id stability)</span>
            <input type="number" min="0" max="1" step="0.05"
                   bind:value={settings.mdblock.similarityThreshold}
                   disabled={!settings.mdblock.enabled}
                   onchange={() => saveSettings()} />
          </label>
        </section>

        <p class="desc">
          ⚠ Strategy / max / min changes affect <strong>new</strong> documents.
          Existing <code>.block.yaml</code> keeps its own config until you run
          <strong>Reset Block Lineage</strong>.
        </p>

        <section class="block">
          <h3>Visualization</h3>
          <p class="desc">
            When Block IDs is enabled, opening any document automatically loads its
            cached yaml and displays markers — no manual "Show" toggle required.
            Use the checkboxes below to opt out of either view individually.
          </p>
          <label class="row">
            <input type="checkbox"
                   bind:checked={settings.mdblock.hover.showSourceGutter}
                   disabled={!settings.mdblock.enabled}
                   onchange={() => saveSettings()} />
            Source-mode markers (in the line-number gutter)
          </label>
          <label class="row">
            <input type="checkbox"
                   bind:checked={settings.mdblock.hover.showRichOverlay}
                   disabled={!settings.mdblock.enabled}
                   onchange={() => saveSettings()} />
            Rich-mode left gutter (block markers + bars)
          </label>
        </section>
      {:else if selectedTab === 'cli'}
        <section class="block">
          <h3>CLI</h3>
          <p class="desc">
            The <code>mdedit</code> command lets you drive M↓ from a terminal
            or other tools — publish files via the Share plugin, list available
            commands, and more.
          </p>
          {#if cliStatus === null}
            <p class="desc">Loading…</p>
          {:else if cliStatus.installed}
            <p class="desc">
              Installed at: <code>{cliStatus.path}</code>
              {#if !cliStatus.target_valid}
                <br />
                <span style="color: tomato;">Symlink points to a different binary — reinstall to repair.</span>
              {/if}
            </p>
            <div class="row" style="gap: 8px; flex-wrap: wrap;">
              <button onclick={handleCliInstall} disabled={cliBusy}>
                {cliBusy ? 'Working…' : 'Reinstall…'}
              </button>
              <button onclick={handleCliUninstall} disabled={cliBusy}>
                {cliBusy ? 'Working…' : 'Uninstall'}
              </button>
            </div>
          {:else}
            <p class="desc">Not installed.</p>
            <button class="primary" onclick={handleCliInstall} disabled={cliBusy}>
              {cliBusy ? 'Installing…' : 'Install…'}
            </button>
          {/if}
          {#if cliError}
            <p class="result fail">Error: {cliError}</p>
          {/if}
          <p class="desc" style="margin-top: 12px;">
            Once installed, run <code>mdedit help</code> in your terminal for the
            full reference. The CLI only exposes commands contributed by
            <em>enabled</em> plugins — disable a plugin in Plugins above to remove
            its subcommand from <code>mdedit</code>.
          </p>
        </section>
      {:else if selectedTab === 'updates'}
        <section class="block">
          <h3>软件更新</h3>
          <p class="desc">
            当前版本：<strong>v{updaterState.currentVersion || '—'}</strong>
          </p>
          <p class="desc">
            上次检查：{formatLastChecked(updaterState.lastCheckedAt)}
          </p>
          <label class="row" style="margin-top: 8px;">
            <input type="checkbox" checked={updaterState.checkOnStartup} onchange={onCheckOnStartupToggle} />
            启动时自动检查更新（每 20 小时一次）
          </label>
          <div class="row" style="gap: 8px; flex-wrap: wrap; margin-top: 10px;">
            <button onclick={handleCheckUpdate} disabled={updaterBusy || updaterState.state === 'checking' || updaterState.state === 'downloading'}>
              {updaterState.state === 'checking' ? '检查中…' : '立即检查更新'}
            </button>
            {#if hasUpdateForSettings() && updaterState.state !== 'downloading' && updaterState.state !== 'ready'}
              <button class="primary" onclick={handleUpdateNow} disabled={updaterBusy}>
                下载并安装 v{updaterState.latestVersion}
              </button>
            {/if}
            {#if updaterState.state === 'ready'}
              <button class="primary" onclick={handleRestart}>立即重启完成更新</button>
            {/if}
          </div>

          {#if updaterState.state === 'downloading'}
            <p class="desc" style="margin-top: 10px;">
              下载中：
              {#if updaterState.contentLength}
                {Math.round((updaterState.downloaded / updaterState.contentLength) * 100)}%
              {:else}
                {(updaterState.downloaded / 1024 / 1024).toFixed(1)} MB
              {/if}
            </p>
          {/if}

          {#if updaterMessage}
            <p class="result" class:ok={updaterState.state === 'uptodate'} class:fail={updaterState.state === 'error'}>
              {updaterMessage}
            </p>
          {/if}

          {#if updaterState.state === 'available' && updaterState.notes}
            <details style="margin-top: 12px;">
              <summary>v{updaterState.latestVersion} 更新说明</summary>
              <pre style="margin-top: 8px; white-space: pre-wrap; word-break: break-word; background: color-mix(in srgb, CanvasText 5%, transparent); padding: 8px; border-radius: 6px; font-size: 11px;">{updaterState.notes}</pre>
            </details>
          {/if}

          <p class="desc" style="margin-top: 14px;">
            更新通过 GitHub Releases 分发，下载前会用内置公钥校验签名；只有签名通过的包才会被替换到 .app 中。
          </p>
        </section>
      {:else if selectedTab === 'vault' && isIOSPlatform}
        <VaultSettingsTab />
      {:else if selectedTab === 'openclaw' && isPluginActive('openclaw-chat')}
        <OpenClawSettingsTab />
        <OpenClawDevicesTab />
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
