<script lang="ts">
  import './styles/app.css'
  import './styles/editor-base.css'
  import './styles/skins/default.css'
  import './styles/skins/effie.css'
  import { onMount } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { listen } from '@tauri-apps/api/event'
  import { invoke } from '@tauri-apps/api/core'
  import { onOpenUrl } from '@tauri-apps/plugin-deep-link'
  import TabBar from './components/TabBar.svelte'
  import EditorPane from './components/EditorPane.svelte'
  import EmptyState from './components/EmptyState.svelte'
  import ModeToggle from './components/ModeToggle.svelte'
  import { activeTab, tabs, closeTab, openFile } from './lib/tabs.svelte'
  import { loadSettings, settings } from './lib/settings.svelte'
  import { cmdOpen, cmdSave, cmdSaveAs, cmdCloseActive, cmdToggleMode } from './lib/commands'
  import { cmdMdblockRefresh } from './lib/mdblock/commands'
  import { confirmDirtyClose } from './lib/dialogs'
  import { startAutoSaveWatcher } from './lib/autosave.svelte'
  import { installFocusPoll } from './lib/file-watcher.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'
  import Toast from './components/Toast.svelte'
  import { invokePlugin } from './lib/plugins/host'
  import { applyActions, configureActionHandlers } from './lib/plugins/action-handlers'
  import { bakeShareHtml } from './lib/plugins/share-baker'
  import { skin } from './lib/skin.svelte'
  import { renderTabAsInlineBody, buildPdfTitle } from './lib/plugins/host-render-html'
  import { renderFilenameTemplate } from './lib/plugins/prompt'
  import {
    collectMenuItems, evaluateEnabled, parsePluginMenuId,
    type CollectedItem, type CollectedItems,
  } from './lib/plugins/menu-registry'
  import { pluginRuntime, setPluginDispatcher } from './lib/plugins/runtime.svelte'
  import { getPluginScopedAll, pluginScopedVersion } from './lib/settings.svelte'
  import { pushToast } from './lib/toast.svelte'
  import type { PluginManifest, EnabledWhenContext } from './lib/plugins/types'

  let showSettings = $state(false)
  let collectedItems = $derived<CollectedItems>(collectMenuItems(pluginRuntime.manifests))
  // Tracks last applied enabled state per menu-item id, so we only invoke the
  // Tauri command when something actually changes.
  const lastEnabledState = new Map<string, boolean>()

  onMount(() => {
    let stopAutoSave: (() => void) | undefined
    let dispatchPlugin: (pluginId: string, command: string) => Promise<void> = async () => {}

    ;(async () => {
      try { await loadSettings() } catch (e) { console.warn('[App] loadSettings:', e) }
      try {
        const { installHoverInvalidator } = await import('./lib/mdblock-hover/hover-store.svelte')
        installHoverInvalidator()
      } catch (e) { console.warn('[App] installHoverInvalidator:', e) }
      // Sync persisted skin into the reactive skin module so RichEditor's
      // [data-skin] binding picks it up before first mount.
      try {
        const { skin: skinState } = await import('./lib/skin.svelte')
        const { settings: s } = await import('./lib/settings.svelte')
        if (s.skin === 'default' || s.skin === 'effie') skinState.current = s.skin
      } catch (e) { console.warn('[App] hydrate skin:', e) }
      stopAutoSave = startAutoSaveWatcher()

      try { pluginRuntime.manifests = await invoke<PluginManifest[]>('get_plugin_manifests') }
      catch (e) { console.warn('[App] get_plugin_manifests:', e) }
      const manifestById: Record<string, PluginManifest> = Object.fromEntries(
        pluginRuntime.manifests.map((m) => [m.id, m]))

      dispatchPlugin = async (pluginId: string, command: string) => {
        const m = manifestById[pluginId]
        if (!m) { console.warn('[App] unknown plugin', pluginId); return }
        const menu = m.menus?.find((me) => me.command === command)
        const tab = activeTab()
        const snap = {
          path: tab?.filePath ?? null,
          filename: tab?.title ?? null,
          extension: tab?.filePath?.split('.').pop() ?? null,
          kind: tab?.kind === 'image' ? 'markdown' : (tab?.kind ?? 'markdown'),
          title: tab ? buildPdfTitle(tab) : 'Untitled',
          isDirty: tab ? tab.currentContent !== tab.initialContent : false,
          isUntitled: !tab?.filePath,
          content: tab?.currentContent ?? '',
        }

        // If the menu item declares a save-dialog prompt, ask the user where
        // to write before invoking. Cancel → silent return.
        let outputPath: string | undefined
        if (menu?.prompt?.kind === 'save-dialog') {
          const { save } = await import('@tauri-apps/plugin-dialog')
          const defaultPath = renderFilenameTemplate(menu.prompt.default_filename, snap.path)
          const picked = await save({ defaultPath, filters: menu.prompt.filters })
          if (!picked) return
          outputPath = picked.endsWith('.pdf') || menu.prompt.filters[0]?.extensions[0] !== 'pdf'
            ? picked
            : `${picked}.pdf`
        }

        let result
        try {
          result = await invokePlugin(m, command, snap, {
            settingsReader: (id) => getPluginScopedAll(id),
            htmlBaker: async (snapshot) => {
              const t = tabs.find((tab) => tab.filePath === snapshot.path)
              if (!t) throw new Error('renderer.html: no matching open tab')
              // Image tabs don't get rendered to HTML — the share plugin's Rust
              // side branches on file extension and uploads bytes directly.
              if (t.kind === 'image') return ''
              // share has its own wrapping (theme CSS, viewport meta, header/footer).
              // Other plugins (md2pdf, future) take just the inline body and wrap
              // it themselves.
              if (m.id === 'share') return bakeShareHtml(t, skin.current)
              return renderTabAsInlineBody(t)
            },
            outputPath,
          })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          const tooLarge = /^share_too_large:(\d+)$/.exec(msg)
          if (tooLarge) {
            const mb = (Number(tooLarge[1]) / 1024 / 1024).toFixed(1)
            pushToast({
              level: 'error',
              message: `❌ ${m.name}: 文档过大（${mb} MB / 上限 25 MB）`,
            })
          } else {
            pushToast({
              level: 'error',
              message: `❌ ${m.name}: 内部错误`,
              detail: msg,
            })
          }
          return
        }
        if (result.ok && result.response) {
          await applyActions(result.response.actions, m)
        } else {
          pushToast({ level: 'error', message: result.errorMessage ?? 'Plugin error', detail: result.errorDetail })
        }
      }

      // Register the reinvoke handler so dialog.confirm action-flow can re-enter
      // through the same plugin-dispatch path.
      configureActionHandlers({ reinvokePlugin: dispatchPlugin })
      // Make dispatchPlugin reachable from other components (TabBar's right-click).
      setPluginDispatcher(dispatchPlugin)
    })()

    const uninstallFocus = installFocusPoll()

    window.addEventListener('keydown', onKeyDown)

    const win = getCurrentWindow()
    const unlistenClose = win.onCloseRequested(async (event) => {
      // Walk dirty tabs; user can cancel.
      for (const t of [...tabs]) {
        const ok = await closeTab(t.id, confirmDirtyClose)
        if (!ok) { event.preventDefault(); return }
      }
      // All tabs closed cleanly → quit the app explicitly.
      // macOS NSWindow's default behavior is hide-not-destroy on close, so we
      // need to call our Rust `quit_app` command to actually exit the process.
      try { await invoke('quit_app') } catch (e) { console.warn('[App] quit_app:', e) }
    })

    const unlistenMenu = listen<string>('menu-event', async (e) => {
      const id = e.payload
      const plugin = parsePluginMenuId(id)
      if (plugin) {
        await dispatchPlugin(plugin.pluginId, plugin.command)
        return
      }
      switch (id) {
        case 'open':        cmdOpen(); break
        case 'save':        cmdSave(); break
        case 'save-as':     cmdSaveAs(); break
        case 'close-tab':   cmdCloseActive(); break
        case 'toggle-mode': cmdToggleMode(); break
        case 'preferences': showSettings = true; break
        case 'docs':
          import('@tauri-apps/plugin-opener')
            .then(({ openUrl }) => openUrl('https://github.com/bruce/mdeditor'))
            .catch(() => {})
          break
      }
    })

    const unlistenDrop = win.onDragDropEvent(async (event) => {
      if (event.payload.type === 'drop') {
        for (const path of event.payload.paths) {
          try { await openFile(path) } catch (e) { console.warn('[App] drop openFile:', e) }
        }
      }
    })

    const unlistenOpenFile = listen<string>('open-file', async (e) => {
      try { await openFile(e.payload) } catch (err) { console.warn('[App] open-file:', err) }
    })

    // tauri-plugin-deep-link `onOpenUrl` — handles macOS Apple Events for
    // file associations. Fires for: Finder double-click, "Open With → M↓",
    // drag-onto-Dock-icon, when the app is registered as the file's handler.
    // URLs come as `file:///path/to/file.md` (already URL-decoded by plugin).
    const unlistenDeepLink = onOpenUrl((urls) => {
      for (const url of urls) {
        let path = url
        if (path.startsWith('file://')) {
          try {
            const u = new URL(path)
            path = decodeURIComponent(u.pathname)
          } catch {
            // Fall through; openFile will reject if path is bad
          }
        }
        openFile(path).catch((err) => console.warn('[App] deep-link openFile:', path, err))
      }
    })

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      uninstallFocus()
      unlistenClose.then((fn) => fn())
      unlistenMenu.then((fn) => fn())
      unlistenDrop.then((fn) => fn())
      unlistenOpenFile.then((fn) => fn())
      unlistenDeepLink.then((fn) => fn())
      stopAutoSave?.()
    }
  })

  function onKeyDown(e: KeyboardEvent) {
    if (!e.metaKey) return
    const k = e.key.toLowerCase()
    if (k === 'o') { e.preventDefault(); cmdOpen() }
    else if (k === 's' && !e.shiftKey) { e.preventDefault(); cmdSave() }
    else if (k === 's' && e.shiftKey) { e.preventDefault(); cmdSaveAs() }
    else if (k === 'w') { e.preventDefault(); cmdCloseActive() }
    else if (k === '/') { e.preventDefault(); cmdToggleMode() }
    else if (k === 'b' && e.shiftKey && settings.mdblock.enabled) {
      e.preventDefault()
      void cmdMdblockRefresh()
    }
  }

  let current = $derived(activeTab())

  // Window title: filename when single tab, plain "M↓" otherwise
  $effect(() => {
    const tabCount = tabs.length
    const title = tabCount === 1 && current ? `${current.title} — M↓` : 'M↓'
    getCurrentWindow().setTitle(title).catch(() => {})
  })

  // Re-evaluate enabled_when expressions whenever the active tab, its content
  // (for hasContent/isDirty), or plugin-scoped settings change. Pushes the
  // result to the native menu via the Tauri command. Deduped so we only
  // invoke when state actually flips.
  $effect(() => {
    const tab = current
    // Read these so the effect re-runs on tab/content changes:
    const _tabCount = tabs.length
    const _settingsTick = pluginScopedVersion.value
    void _tabCount; void _settingsTick

    const ewTab: EnabledWhenContext['currentTab'] = tab
      ? {
          path: tab.filePath || null,
          filename: tab.title || null,
          extension: tab.filePath ? (tab.filePath.split('.').pop() ?? null) : null,
          kind: tab.kind === 'image' ? null : tab.kind,
          hasContent: tab.kind === 'image' ? !!tab.filePath : (tab.currentContent ?? '').length > 0,
          isDirty: tab.currentContent !== tab.initialContent,
          isUntitled: !tab.filePath,
        }
      : null

    const allItems: CollectedItem[] = [
      ...collectedItems.file,
      ...collectedItems.edit,
      ...collectedItems.view,
      ...collectedItems.window,
      ...collectedItems.help,
      ...collectedItems.plugins,
    ]

    for (const item of allItems) {
      if (!item.enabledWhen) continue  // always-enabled — no need to invoke
      const ctx: EnabledWhenContext = {
        currentTab: ewTab,
        settings: getPluginScopedAll(item.pluginId),
      }
      const enabled = evaluateEnabled(item, ctx)
      if (lastEnabledState.get(item.id) === enabled) continue
      lastEnabledState.set(item.id, enabled)
      invoke('set_plugin_menu_item_enabled', { id: item.id, enabled })
        .catch((e) => console.warn(`[App] set_plugin_menu_item_enabled ${item.id}:`, e))
    }
  })
</script>

<main>
  <TabBar />
  <section class="pane">
    {#if current}
      {#if tabs.length === 1}
        <div class="float-toggle"><ModeToggle tab={current} /></div>
      {/if}
      <EditorPane tab={current} />
    {:else}
      <EmptyState />
    {/if}
  </section>
  <SettingsDialog bind:open={showSettings} />
  <Toast />
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .pane {
    position: relative;
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .pane :global(.empty),
  .pane :global(.src),
  .pane :global(.rich-wrap),
  .pane :global(.html-preview-wrap),
  .pane :global(.image-preview-wrap) {
    flex: 1;
    min-width: 0;
  }
  .float-toggle {
    position: absolute;
    top: 0;
    right: 28px;
    z-index: 10;
  }
</style>
