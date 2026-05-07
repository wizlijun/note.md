<script lang="ts">
  import './styles/app.css'
  import { onMount } from 'svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import TabBar from './components/TabBar.svelte'
  import EditorPane from './components/EditorPane.svelte'
  import EmptyState from './components/EmptyState.svelte'
  import ModeToggle from './components/ModeToggle.svelte'
  import { activeTab, tabs, closeTab } from './lib/tabs.svelte'
  import { loadSettings } from './lib/settings.svelte'
  import { cmdOpen, cmdSave, cmdSaveAs, cmdCloseActive, cmdToggleMode } from './lib/commands'
  import { confirmDirtyClose } from './lib/dialogs'
  import { startAutoSaveWatcher } from './lib/autosave.svelte'

  onMount(() => {
    let stopAutoSave: (() => void) | undefined

    ;(async () => {
      try { await loadSettings() } catch (e) { console.warn('[App] loadSettings:', e) }
      stopAutoSave = startAutoSaveWatcher()
    })()

    window.addEventListener('keydown', onKeyDown)

    const win = getCurrentWindow()
    const unlisten = win.onCloseRequested(async (event) => {
      for (const t of [...tabs]) {
        const ok = await closeTab(t.id, confirmDirtyClose)
        if (!ok) {
          event.preventDefault()
          return
        }
      }
    })

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      unlisten.then((fn) => fn())
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
</script>

<main>
  <TabBar />
  <section class="pane">
    {#if current}
      <ModeToggle tab={current} />
      <EditorPane tab={current} />
    {:else}
      <EmptyState />
    {/if}
  </section>
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
  .pane :global(textarea.source),
  .pane :global(.rich) {
    flex: 1;
  }
</style>
