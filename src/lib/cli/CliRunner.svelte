<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { invokePlugin } from '../plugins/host'
  import { bakeShareHtml } from '../plugins/share-baker'
  import { renderTabAsInlineBody } from '../plugins/host-render-html'
  import { settings } from '../settings.svelte'
  import { computeActiveThemeId } from '../theme-loader'
  import { stat, readTextFile, mkdir, writeTextFile } from '@tauri-apps/plugin-fs'
  import { writeText as clipWriteText } from '@tauri-apps/plugin-clipboard-manager'
  import { mergePluginScoped, getPluginScopedAll, loadSettings } from '../settings.svelte'
  import { generateInsightsReport } from '../insights/run'
  import { presetRange, type Preset } from '../insights/value'
  import { localTzOffsetMinutes } from '../insights/model'
  import { sha256Hex } from '../hash'
  import { publishHtml } from '../share/publish'
  import { unpublish } from '../share/unpublish'
  import { copyShareLink } from '../share/copy-link'
  import { uploadImage } from '../share/upload-image'
  import { ShareError } from '../share/types'
  import { getRecord } from '../share/records'
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

  /** `notemd reading-insights report` — file-less; generates the digest (owner +
   *  online audience) and writes it to <vault>/stat or prints to stdout. */
  async function runInsightsReport(payload: CliPayload): Promise<void> {
    try {
      const vaultFlag = (payload.flags['vault'] as string | undefined) || undefined
      const vaultRoot = vaultFlag ?? (await invoke<string | null>('sotvault_vault_root'))
      if (!vaultRoot) {
        await finish({ exit_code: 2, stderr: ['notemd: no Vault configured. Pass --vault <path> or configure one in the app.'] })
        return
      }
      let from = payload.flags['from'] as string | undefined
      let to = payload.flags['to'] as string | undefined
      if (!from || !to) {
        const valid = ['today', 'yesterday', '7d', '30d', 'month']
        const dateFlag = payload.flags['date'] as string | undefined
        const preset = (dateFlag && valid.includes(dateFlag) ? dateFlag : 'yesterday') as Preset
        const r = presetRange(preset, Date.now(), localTzOffsetMinutes())
        from = r.from
        to = r.to
      }
      const { filename, markdown } = await generateInsightsReport(from, to, vaultRoot)
      if (payload.flags['stdout']) {
        await finish({ exit_code: 0, stdout: markdown, stderr: [] })
        return
      }
      const base = vaultRoot.replace(/\/$/, '')
      await mkdir(`${base}/stat`, { recursive: true }).catch(() => {})
      const abs = `${base}/${filename}`
      await writeTextFile(abs, markdown)
      await finish({ exit_code: 0, stdout: `wrote ${abs}`, stderr: [] })
    } catch (e) {
      await finish({ exit_code: 1, stderr: [`notemd: reading-insights report failed: ${e}`] })
    }
  }

  /** 分享报错时的 vault 诊断:读了哪个配置文件、sotvault 值、各层解析结果、文件与
   *  vault 的关系。原样打印(不改大小写),便于发现 Sync/sync 之类不一致。best-effort。 */
  async function shareVaultDiagnostics(filePath: string): Promise<string[]> {
    const lines: string[] = []
    const add = (k: string, v: unknown) =>
      lines.push(`  ${k}: ${v === undefined ? '(undefined)' : v === null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v)}`)
    add('file', filePath)
    try {
      const { homeDir } = await import('@tauri-apps/api/path')
      const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
      const cfgPath = `${await homeDir()}/Library/Application Support/com.laobu.mdeditor-shared/config.json`
      add('shared config', cfgPath)
      const cfgExists = await exists(cfgPath).catch(() => false)
      add('shared config exists', cfgExists)
      if (cfgExists) {
        const raw = await readTextFile(cfgPath).catch(() => '')
        let sotvault: unknown = '(parse failed)'
        try { sotvault = JSON.parse(raw).sotvault } catch { /* keep placeholder */ }
        add('config.sotvault', sotvault)
      }
    } catch (e) { add('config read error', String(e)) }
    try {
      const backendRoot = await invoke<string | null>('sotvault_vault_root').catch(() => null)
      add('sotvault_vault_root() → backend', backendRoot)
      const { sotvaultStore } = await import('../sotvault.svelte')
      add('store.vaultRoot', sotvaultStore.vaultRoot)
      if (backendRoot) {
        const r = backendRoot.endsWith('/') ? backendRoot : `${backendRoot}/`
        add('file under vault? (case-sensitive)', filePath === backendRoot || filePath.startsWith(r))
      }
    } catch (e) { add('resolve error', String(e)) }
    try {
      const dbg = await invoke<unknown>('sotvault_vault_debug').catch((e) => ({ error: String(e) }))
      lines.push(`  backend debug: ${JSON.stringify(dbg)}`)
    } catch (e) { add('backend debug error', String(e)) }
    return lines
  }

  /** stat/read the file and build the virtual Tab shape shared by the share
   *  path and the generic plugin path. For image files content stays empty —
   *  downstream consumers (bakeShareHtml, uploadImage) re-read bytes via
   *  tauri-plugin-fs. On read failure, finishes with exit 2 and returns null. */
  async function buildVirtualTab(
    file: string,
  ): Promise<{ tab: Tab; extension: string | null; fileKind: FileKind } | null> {
    let fileContent = ''
    let fileMtime = 0
    try {
      const info = await stat(file)
      fileMtime = info.mtime ? new Date(info.mtime).getTime() : 0
      if (inferKind(extensionOf(basenameOf(file))) !== 'image') {
        fileContent = await readTextFile(file)
      }
    } catch (e) {
      await finish({ exit_code: 2, stderr: [`notemd: cannot read '${file}': ${e}`] })
      return null
    }
    const filename = basenameOf(file)
    const extension = extensionOf(filename)
    const fileKind = toFileKind(inferKind(extension))
    // Build a real Tab shape — share-baker reads filePath, currentContent, kind, title.
    const tab: Tab = {
      id: 'cli',
      filePath: file,
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
    return { tab, extension, fileKind }
  }

  /** `notemd share` — share 是 core：走 TS 实现（与桌面菜单同一套
   *  publish/unpublish/copy-link/upload-image），无插件二进制。复用与菜单
   *  一致的 vault-home 前置与 bake 流程；结果按 --json/--clipboard 约定输出。
   *
   *  Output contract (mirrors old plugin-binary behaviour consumed by md2pdf
   *  interpretActions and `notemd help` EXIT CODES):
   *  - success --json: { ok: true, data: { ... } }, exit 0
   *  - failure --json: { ok: false, error: { code, message } } on stdout + stderr, exit 4
   *  - failure non-json: stderr only, exit 4
   *  - exit 2 reserved for file/argument errors (missing file — before dispatch)
   */
  async function runShareCli(payload: CliPayload): Promise<void> {
    if (!payload.file) {
      await finish({ exit_code: 2, stderr: ['notemd: missing file argument'] })
      return
    }
    const file = payload.file

    /** Emit a share operation failure (exit 4). Writes JSON envelope to stdout
     *  when --json; always writes human message to stderr. */
    async function failShare(code: string, message: string): Promise<void> {
      const stderr = [`notemd: share failed: ${message}`]
      if (payload.global.json) {
        await finish({
          exit_code: 4,
          stdout: JSON.stringify({ ok: false, error: { code, message } }),
          stderr,
        })
      } else {
        await finish({ exit_code: 4, stderr })
      }
    }

    try {
      if (payload.plugin_command === 'copy-link') {
        // copyShareLink internally writes clipboard; no extra write needed.
        const rec = getRecord(file)
        const url = await copyShareLink(file)
        const slug = rec?.kind !== 'image' ? (rec as any)?.slug as string | undefined : undefined
        const data: Record<string, string> = { url }
        if (slug) data.slug = slug
        await finish({
          exit_code: 0,
          stdout: payload.global.json ? JSON.stringify({ ok: true, data }) : url,
          stderr: [],
        })
        return
      }

      const { getShareConfig } = await import('../share')
      const cfg = getShareConfig()
      if (!cfg) {
        const msg = 'share not configured (baseUrl/apiKey)'
        if (payload.global.json) {
          await finish({
            exit_code: 4,
            stdout: JSON.stringify({ ok: false, error: { code: 'not_configured', message: msg } }),
            stderr: [`notemd: ${msg}`],
          })
        } else {
          await finish({ exit_code: 4, stderr: [`notemd: ${msg}`] })
        }
        return
      }

      if (payload.plugin_command === 'unpublish') {
        // Read record BEFORE unpublish so we capture slug (unpublish deletes it).
        const recBefore = getRecord(file)
        const slugBefore = recBefore?.kind !== 'image'
          ? (recBefore as any)?.slug as string | undefined
          : undefined
        await unpublish({ path: file, baseUrl: cfg.baseUrl })
        const data: Record<string, unknown> = { removed: true }
        if (slugBefore) data.slug = slugBefore
        await finish({
          exit_code: 0,
          stdout: payload.global.json
            ? JSON.stringify({ ok: true, data })
            : `unshared ${file}`,
          stderr: [],
        })
        return
      }

      // 'publish' (default; --update maps here too)
      const built = await buildVirtualTab(file)
      if (!built) return
      const { tab, fileKind } = built

      if (fileKind === 'image') {
        const { url, isUpdate } = await uploadImage({
          path: file, filename: tab.title,
          baseUrl: cfg.baseUrl, defaultExpiry: cfg.defaultExpiry,
        })
        // slug not applicable for image shares (records use id/ext, not slug)
        if (payload.global.clipboard && !payload.global.json) await clipWriteText(url).catch(() => {})
        await finish({
          exit_code: 0,
          stdout: payload.global.json
            ? JSON.stringify({ ok: true, data: { url, is_update: isUpdate } })
            : url,
          stderr: [],
        })
        return
      }

      // Share via CLI runs the SAME vault-home pre-step as the menu (headless: no
      // flush — the file on disk is the source of truth). Fails the command with a
      // clear message when there's no vault to home the outside file into.
      let src: string
      try {
        // CLI 不走 GUI(App.svelte)的启动 refreshSotvault,故 sotvaultStore.vaultRoot
        // 一直是 null;prepareShareSrc 用它判 vault → 误报 vault_required。先加载。
        const { refreshSotvault } = await import('../sotvault.svelte')
        await refreshSotvault()
        const { prepareShareSrc } = await import('../share')
        src = await prepareShareSrc(file)
      } catch (e) {
        // 详细诊断:报错时列出读了哪个配置文件、sotvault 值、各层解析结果、文件路径
        // (原样打印,便于发现 Sync/sync 之类大小写不一致)。
        const msg = e instanceof Error ? e.message : String(e)
        const code = e instanceof ShareError ? e.kind : 'share_failed'
        const diagLines = await shareVaultDiagnostics(file)
        if (payload.global.json) {
          await finish({
            exit_code: 4,
            stdout: JSON.stringify({ ok: false, error: { code, message: msg } }),
            stderr: [`notemd: share failed: ${msg}`, ...diagLines],
          })
        } else {
          await finish({
            exit_code: 4,
            stderr: [`notemd: share failed: ${msg}`, ...diagLines],
          })
        }
        return
      }

      const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
      const themeId = computeActiveThemeId(settings.theme, systemDark)
      // bakeShareHtml throws ShareError('too_large') itself when input/output
      // exceeds 25 MB — the outer catch maps it to exit 4 / code 'too_large'.
      const html = await bakeShareHtml(tab, themeId)
      if (!html) {
        await failShare('empty_content', 'empty_content')
        return
      }

      const { url, slug, isUpdate } = await publishHtml({
        path: file, filename: tab.title, html,
        baseUrl: cfg.baseUrl,
        defaultExpiry: cfg.defaultExpiry,
        slugRandomSuffix: cfg.slugRandomSuffix,
        src,
      })
      if (payload.global.clipboard && !payload.global.json) await clipWriteText(url).catch(() => {})
      await finish({
        exit_code: 0,
        stdout: payload.global.json
          ? JSON.stringify({ ok: true, data: { url, slug, is_update: isUpdate } })
          : url,
        stderr: [],
      })
    } catch (e) {
      if (e instanceof ShareError) {
        await failShare(e.kind, `${e.kind}${e.detail ? ': ' + e.detail : ''}`)
      } else {
        await failShare('share_failed', String(e))
      }
    }
  }

  async function run(): Promise<void> {
    let payload: CliPayload
    try {
      payload = await invoke<CliPayload>('cli_payload')
    } catch (e) {
      await finish({ exit_code: 1, stderr: [`notemd: failed to fetch cli payload: ${e}`] })
      return
    }

    // Hydrate the in-memory settings store from disk BEFORE any plugin
    // action emits `settings.merge`. Without this, the runner sees defaults
    // for every key, and the first save (e.g., updating share.records) wipes
    // the user's stored apiKey / baseUrl / plugins.enabled / recentFiles.
    try {
      await loadSettings()
    } catch (e) {
      await finish({ exit_code: 1, stderr: [`notemd: failed to load settings: ${e}`] })
      return
    }

    // reading-insights report: a file-less command that reuses the in-app report
    // logic (owner analytics from the Vault + audience stats fetched online with
    // the configured share API key + records). No plugin binary involved.
    if (payload.plugin_id === 'reading-insights') {
      await runInsightsReport(payload)
      return
    }

    // share 是 core：走 TS 实现，无插件二进制。复用与菜单一致的
    // vault-home 前置与 bake 流程；结果按 --json/--quiet 约定输出。
    if (payload.plugin_id === 'share') {
      await runShareCli(payload)
      return
    }

    const manifests = await invoke<PluginManifest[]>('get_plugin_manifests')
    const manifest = manifests.find(m => m.id === payload.plugin_id)
    if (!manifest) {
      await finish({ exit_code: 3, stderr: [
        `notemd: plugin '${payload.plugin_id}' is not enabled. Run 'notemd plugin enable ${payload.plugin_id}'.`,
      ]})
      return
    }
    if (!payload.file) {
      await finish({ exit_code: 2, stderr: ['notemd: missing file argument'] })
      return
    }

    const built = await buildVirtualTab(payload.file)
    if (!built) return
    const { tab: virtualTab, extension, fileKind } = built

    // For commands requiring rendered HTML, bake the content.
    const entry = (manifest.cli ?? []).find(c => c.subcommand === payload.subcommand)
    let renderedHtml: string | undefined
    if (entry?.requires_tab_context && manifest.host_capabilities.includes('renderer.html')) {
      try {
        renderedHtml = fileKind === 'image' ? '' : await renderTabAsInlineBody(virtualTab)
      } catch (e) {
        await finish({ exit_code: 1, stderr: [`notemd: render failed: ${e}`] })
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

    const pluginSettings = getPluginScopedAll(manifest.id)

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
        settingsReader: () => pluginSettings,
        outputPath,
      },
    )

    if (!result.ok || !result.response) {
      await finish({
        exit_code: 1,
        stderr: [result.errorMessage ?? 'notemd: plugin invocation failed',
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
      await finish({ exit_code: 1, stderr: [`notemd: unexpected error: ${e}`] })
    })
  })
</script>

<!-- Headless: no DOM body. -->
