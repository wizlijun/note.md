<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { invokePlugin } from '../plugins/host'
  import { bakeShareHtml } from '../plugins/share-baker'
  import { stat, readTextFile } from '@tauri-apps/plugin-fs'
  import { writeText as clipWriteText } from '@tauri-apps/plugin-clipboard-manager'
  import { mergePluginScoped, getPluginScopedAll } from '../settings.svelte'
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

    // For commands requiring rendered HTML (publish), bake; else skip.
    const entry = (manifest.cli ?? []).find(c => c.subcommand === payload.subcommand)
    let renderedHtml: string | undefined
    if (entry?.requires_tab_context && payload.plugin_command === 'publish') {
      try {
        // Image tabs: share plugin handles bytes server-side; skip bake.
        if (fileKind !== 'image') {
          renderedHtml = await bakeShareHtml(virtualTab)
        } else {
          renderedHtml = ''
        }
      } catch (e) {
        await finish({ exit_code: 1, stderr: [`mdedit: render failed: ${e}`] })
        return
      }
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
