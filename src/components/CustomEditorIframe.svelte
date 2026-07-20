<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'
  import type { CustomEditorOpen } from '../lib/plugins/v2/custom-editor-msg'
  import { handleCustomEditorMessage } from '../lib/plugins/v2/custom-editor-msg'

  let { tab }: { tab: Tab } = $props()

  // The plugin origin this iframe loads under. All doc-channel traffic is
  // authenticated against it (targetOrigin on send; event.origin on receive).
  const pluginOrigin = `plugin://${tab.editorPluginId}`
  const src = `plugin://${tab.editorPluginId}/${tab.editorEntry}`

  let iframeEl: HTMLIFrameElement | undefined = $state()

  // On load, hand the file's content to the editor iframe over the document
  // channel (parent → iframe postMessage). NOT JSON-RPC: this is the direct
  // parent↔iframe channel; host.* capability calls go through window.notemd.
  function onLoad() {
    const win = iframeEl?.contentWindow
    if (!win) return
    const open: CustomEditorOpen = {
      type: 'custom_editor.open',
      uri: tab.filePath,
      content: tab.currentContent,
      editorId: tab.editorId ?? '',
    }
    win.postMessage(open, pluginOrigin)
  }

  // Listen for the iframe's edits. Validation (origin + source) lives in the
  // pure `handleCustomEditorMessage` router so it stays unit-testable; a forged
  // message from any other frame/window is ignored there.
  $effect(() => {
    const onMessage = (event: MessageEvent) => {
      handleCustomEditorMessage(event, {
        pluginOrigin,
        expectedSource: iframeEl?.contentWindow,
        onChange: (content) => setContent(tab.id, content),
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  })
</script>

<iframe
  bind:this={iframeEl}
  class="custom-editor-frame"
  title={tab.title}
  {src}
  sandbox="allow-scripts allow-same-origin"
  onload={onLoad}
></iframe>

<style>
  .custom-editor-frame {
    flex: 1;
    width: 100%;
    height: 100%;
    border: none;
    min-width: 0;
    min-height: 0;
    background: Canvas;
  }
</style>
