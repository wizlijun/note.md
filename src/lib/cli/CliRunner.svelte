<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { invokePlugin } from '../plugins/host'
  import { bakeShareHtml } from '../plugins/share-baker'
  import { settings } from '../settings.svelte'
  import { computeActiveThemeId } from '../theme-loader'
  import { stat, readTextFile } from '@tauri-apps/plugin-fs'
  import { writeText as clipWriteText } from '@tauri-apps/plugin-clipboard-manager'
  import { mergePluginScoped, getPluginScopedAll, loadSettings } from '../settings.svelte'
  import { sha256Hex } from '../hash'
  import {
    basenameOf, extensionOf, inferKind, interpretActions,
    type CliPayload,
  } from './cli-runner'
  import type { PluginManifest, TabKind } from '../plugins/types'
  import type { Tab } from '../tabs.svelte'
  import type { FileKind } from '../fs'

  /** Map the broader cli-runner kind to the editor's FileKind (no 'plaintext'). */
  function toFileKind(k: ReturnType<typeof inferKind>): FileKind {
    if (k === 'plaintext') return 'code'
    return k
  }

  /** Map FileKind to the narrower TabKind used in the plugin request context.
   *  Image tabs are reported as 'markdown' (matches App.svelte's snapshot
   *  builder); the share plugin's Rust side branches on extension anyway. */
  function toTabKind(k: FileKind): TabKind {
    if (k === 'image') return 'markdown'
    return k
  }

  async function run(): Promise<void> {
    let payload: CliPayload
    try {
      payload = await invoke<CliPayload>('cli_payload')
    } catch (e) {
      await finish({ exit_code: 1, stderr: [`mdedit: failed to fetch cli payload: ${e}`] })
      return
    }

    // Hydrate the in-memory settings store from disk BEFORE any plugin
    // action emits `settings.merge`. Without this, the runner sees defaults
    // for every key, and the first save (e.g., updating share.records) wipes
    // the user's stored apiKey / baseUrl / plugins.enabled / recentFiles.
    try {
      await loadSettings()
    } catch (e) {
      await finish({ exit_code: 1, stderr: [`mdedit: failed to load settings: ${e}`] })
      return
    }

    const manifests = await invoke<PluginManifest[]>('get_plugin_manifests')
    const manifest = manifests.find(m => m.id === payload.plugin_id)
    if (!manifest) {
      await finish({ exit_code: 3, stderr: [
        `mdedit: plugin '${payload.plugin_id}' is not enabled. Run 'mdedit plugin enable ${payload.plugin_id}'.`,
      ]})
      return
    }
    if (!payload.file) {
      await finish({ exit_code: 2, stderr: ['mdedit: missing file argument'] })
      return
    }

    let fileContent = ''
    let fileMtime = 0
    try {
      const info = await stat(payload.file)
      fileMtime = info.mtime ? new Date(info.mtime).getTime() : 0
      // For image files, content stays empty — bakeShareHtml's image branch
      // re-reads bytes via tauri-plugin-fs. For others, we read text.
      const ext = (extensionOf(basenameOf(payload.file)) ?? '').toLowerCase()
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.heic', '.heif'].includes(ext)
      if (!isImage) {
        fileContent = await readTextFile(payload.file)
      }
    } catch (e) {
      await finish({ exit_code: 2, stderr: [`mdedit: cannot read '${payload.file}': ${e}`] })
      return
    }

    const filename = basenameOf(payload.file)
    const extension = extensionOf(filename)
    const cliKind = inferKind(extension)
    const fileKind = toFileKind(cliKind)

    // Build a real Tab shape — share-baker reads filePath, currentContent, kind, title.
    const virtualTab: Tab = {
      id: 'cli',
      filePath: payload.file,
      title: filename,
      initialContent: fileContent,
      currentContent: fileContent,
      mode: 'source',
      kind: fileKind,
      externalState: 'fresh',
      externalBannerDismissed: false,
      lastKnownMtime: fileMtime,
      lastKnownHash: fileContent ? await sha256Hex(fileContent) : '',
    }

    // For commands requiring rendered HTML, bake the content.
    const entry = (manifest.cli ?? []).find(c => c.subcommand === payload.subcommand)
    let renderedHtml: string | undefined
    if (entry?.requires_tab_context && manifest.host_capabilities.includes('renderer.html')) {
      try {
        if (fileKind !== 'image') {
          const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
          const themeId = computeActiveThemeId(settings.theme, systemDark)
          renderedHtml = await bakeShareHtml(virtualTab, themeId)
        } else {
          renderedHtml = ''
        }
      } catch (e) {
        await finish({ exit_code: 1, stderr: [`mdedit: render failed: ${e}`] })
        return
      }
    }

    // Resolve output_path for plugins that need it (e.g. md2pdf export).
    let outputPath: string | undefined
    const outputFlag = payload.flags['output'] as string | undefined
    if (outputFlag) {
      outputPath = outputFlag.startsWith('/') ? outputFlag
        : `${payload.file!.replace(/\/[^/]+$/, '')}/${outputFlag}`
    } else if (manifest.id === 'md2pdf') {
      outputPath = payload.file!.replace(/\.[^.]+$/, '.pdf')
    }

    const settings = getPluginScopedAll(manifest.id)

    const result = await invokePlugin(
      manifest,
      payload.plugin_command,
      {
        path: virtualTab.filePath,
        filename: virtualTab.title,
        extension,
        kind: toTabKind(virtualTab.kind),
        title: virtualTab.title,
        isDirty: false,
        isUntitled: false,
        content: virtualTab.currentContent,
      },
      {
        htmlBaker: renderedHtml != null ? async () => renderedHtml! : undefined,
        settingsReader: () => settings,
        outputPath,
      },
    )

    if (!result.ok || !result.response) {
      await finish({
        exit_code: 1,
        stderr: [result.errorMessage ?? 'mdedit: plugin invocation failed',
                 result.errorDetail ?? ''].filter(Boolean),
      })
      return
    }

    const interp = interpretActions(
      result.response.actions, manifest, payload,
      { isTty: false, writeClipboard: clipWriteText, writeSettings: mergePluginScoped },
    )

    await finish({
      exit_code: interp.exitCode,
      stdout: interp.stdout ?? '',
      stderr: interp.stderr,
    })
  }

  async function finish(r: { exit_code: number; stdout?: string; stderr: string[] }): Promise<void> {
    try {
      await invoke('cli_finish', { result: r })
    } catch (e) {
      console.error('[cli] cli_finish failed:', e)
    }
  }

  onMount(() => {
    run().catch(async (e) => {
      await finish({ exit_code: 1, stderr: [`mdedit: unexpected error: ${e}`] })
    })
  })
</script>

<!-- Headless: no DOM body. -->
