<script lang="ts">
  import type { MorayaEditorInstance } from '@moraya/core'
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'
  import { mountRichEditor } from '../lib/editor-bridge'

  let { tab }: { tab: Tab } = $props()

  let richHost: HTMLDivElement | undefined = $state()
  let editor: MorayaEditorInstance | null = null
  let mounted = $state<{ tabId: string; mode: 'source' | 'rich' } | null>(null)

  function flushRichToTab() {
    if (editor && mounted?.mode === 'rich' && mounted.tabId === tab.id) {
      try {
        const md = editor.getMarkdown()
        setContent(mounted.tabId, md)
      } catch (e) {
        console.warn('[EditorPane] flush failed:', e)
      }
    }
  }

  function destroyEditor() {
    if (editor) {
      try { editor.destroy() } catch (e) { console.warn(e) }
      editor = null
    }
    if (richHost) richHost.innerHTML = ''
  }

  $effect(() => {
    const tabId = tab.id
    const mode = tab.mode

    if (mounted && (mounted.tabId !== tabId || mounted.mode !== mode)) {
      flushRichToTab()
      destroyEditor()
      mounted = null
    }

    if (mode === 'rich' && !mounted && richHost) {
      const host = richHost
      mountRichEditor(host, tab, (md) => setContent(tabId, md))
        .then((inst) => {
          editor = inst
          mounted = { tabId, mode: 'rich' }
        })
        .catch((e) => console.error('[EditorPane] mount failed:', e))
    } else if (mode === 'source' && !mounted) {
      mounted = { tabId, mode: 'source' }
    }

    return () => {
      flushRichToTab()
      destroyEditor()
    }
  })

  function onSourceInput(e: Event) {
    const ta = e.currentTarget as HTMLTextAreaElement
    setContent(tab.id, ta.value)
  }
</script>

{#if tab.mode === 'source'}
  <textarea
    class="source"
    value={tab.currentContent}
    oninput={onSourceInput}
    spellcheck="true"
  ></textarea>
{:else}
  <div class="rich" bind:this={richHost}></div>
{/if}

<style>
  .source {
    width: 100%;
    height: 100%;
    border: 0;
    outline: none;
    resize: none;
    padding: 16px 24px;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 14px;
    line-height: 1.6;
    background: Canvas;
    color: CanvasText;
    box-sizing: border-box;
  }
  .rich {
    width: 100%;
    height: 100%;
    overflow: auto;
    padding: 16px 24px;
    box-sizing: border-box;
  }
  .rich :global(.ProseMirror) {
    outline: none;
    min-height: 100%;
  }
</style>
