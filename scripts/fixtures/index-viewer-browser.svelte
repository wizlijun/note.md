<script lang="ts">
  import FilePluginView from '../../src/components/FilePluginView.svelte'
  import ModeToggle from '../../src/components/ModeToggle.svelte'
  import { i18n } from '../../src/lib/i18n/store.svelte'
  import { pluginRuntime } from '../../src/lib/plugins/runtime.svelte'
  import { fallbackFileView, fileViewPresentation, retryFileViewAfterReload } from '../../src/lib/plugins/file-view-presentation.svelte'
  import { tabs, activeId, type Tab } from '../../src/lib/tabs.svelte'
  import type { PluginManifest } from '../../src/lib/plugins/types'
  import sourceManifest from '../../plugins-src/index-viewer/manifest.v2.json'
  import initial from '../../skills/file-index/assets/board.index.md?raw'

  i18n.locale = 'zh'
  const manifest = { ...sourceManifest, binary: '', host_capabilities: sourceManifest.capabilities, file_views: sourceManifest.contributes.file_views } as PluginManifest
  let tab = $state({ id: 'index-fixture', filePath: '/fixture-vault/assets/demo.index.md', title: 'demo.index.md', kind: 'markdown', mode: 'rich', currentContent: initial, initialContent: initial } as Tab)
  tabs.push(tab)
  activeId.value = tab.id
  let presentation = $derived(fileViewPresentation(tab, [manifest]))
  let view = $derived(tab.mode === 'rich' ? presentation.active : null)
  $effect(() => { pluginRuntime.manifests = [manifest] })
  Object.assign(window, { __indexBrowser: {
    get content() { return tab.currentContent },
    reload(content: string) {
      tab.currentContent = content
      retryFileViewAfterReload(tab)
      window.dispatchEvent(new CustomEvent('notemd:auto-reloaded', { detail: { tabId: tab.id } }))
    },
  } })
</script>

<main class="fixture">
  <div class="viewbar"><ModeToggle {tab}/></div>
  {#if tab.mode === 'source'}
    <textarea aria-label="Markdown 源码" bind:value={tab.currentContent}></textarea>
  {:else if view}
    <FilePluginView {tab} {view} onFallback={(reason) => fallbackFileView(tab, view!, reason)}>
      {#snippet fallback()}<textarea aria-label="Markdown 编辑器" bind:value={tab.currentContent}></textarea>{/snippet}
    </FilePluginView>
  {:else}<textarea aria-label="Markdown 编辑器" bind:value={tab.currentContent}></textarea>{/if}
</main>

<style>
  :global(html), :global(body), :global(#fixture) { height: 100%; margin: 0; color-scheme: light dark; }
  :global(body) { color: CanvasText; background: Canvas; font-family: system-ui, sans-serif; }
  .fixture { height: 100%; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .viewbar { display: flex; flex: 0 0 34px; align-items: center; justify-content: flex-end; padding: 0 28px; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); }
  textarea { flex: 1; width: 100%; box-sizing: border-box; border: 0; resize: none; color: CanvasText; background: Canvas; padding: 24px; }
</style>
