<script lang="ts">
  import './styles/app.css'
  import { onMount } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { listen } from '@tauri-apps/api/event'
  import TabBar from './components/TabBar.svelte'
  import EditorPane from './components/EditorPane.svelte'
  import EmptyState from './components/EmptyState.svelte'
  import ModeToggle from './components/ModeToggle.svelte'
  import { activeTab, tabs, closeTab, openFile } from './lib/tabs.svelte'
  import { loadSettings } from './lib/settings.svelte'
  import { cmdOpen, cmdSave, cmdSaveAs, cmdCloseActive, cmdToggleMode } from './lib/commands'
  import { confirmDirtyClose } from './lib/dialogs'
  import { startAutoSaveWatcher } from './lib/autosave.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'

  let showSettings = $state(false)

  onMount(() => {
    let stopAutoSave: (() => void) | undefined

    ;(async () => {
      try { await loadSettings() } catch (e) { console.warn('[App] loadSettings:', e) }
      stopAutoSave = startAutoSaveWatcher()
    })()

    window.addEventListener('keydown', onKeyDown)

    const win = getCurrentWindow()
    const unlistenClose = win.onCloseRequested(async (event) => {
      for (const t of [...tabs]) {
        const ok = await closeTab(t.id, confirmDirtyClose)
        if (!ok) { event.preventDefault(); return }
      }
    })

    const unlistenMenu = listen<string>('menu-event', (e) => {
      switch (e.payload) {
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

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unlistenClose.then((fn) => fn())
      unlistenMenu.then((fn) => fn())
      unlistenDrop.then((fn) => fn())
      unlistenOpenFile.then((fn) => fn())
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
  }

  let current = $derived(activeTab())

  // Window title: filename when single tab, plain "mdeditor" otherwise
  $effect(() => {
    const tabCount = tabs.length
    const title = tabCount === 1 && current ? `${current.title} — mdeditor` : 'mdeditor'
    getCurrentWindow().setTitle(title).catch(() => {})
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
  .pane :global(.html-preview-wrap) {
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
