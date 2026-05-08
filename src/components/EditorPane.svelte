<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'
  import RichEditor from './RichEditor.svelte'
  import SourceView from './SourceView.svelte'
  import HtmlPreview from './HtmlPreview.svelte'
  import ExternalChangeBanner from './ExternalChangeBanner.svelte'
  import { offsetToLineCol, lineColToOffset } from '../lib/cursor-preserve'

  let { tab }: { tab: Tab } = $props()

  function onSourceInput(e: Event) {
    const ta = e.currentTarget as HTMLTextAreaElement
    setContent(tab.id, ta.value)
  }

  function onRichFlush(md: string) {
    setContent(tab.id, md)
  }

  // Best-effort cursor preservation when an external change auto-reloads
  // a clean source-mode tab. Re-find the cursor's (line, col) in the new
  // content and reapply. Rich/HTML modes are not handled — their DOM
  // re-renders fully and accurate cursor mapping is out of scope.
  $effect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { tabId: string; oldContent: string; newContent: string }
        | undefined
      if (!detail || detail.tabId !== tab.id) return
      if (tab.mode !== 'source') return
      const ta = document.querySelector<HTMLTextAreaElement>(
        `textarea.src-textarea[data-tab-id="${tab.id}"]`,
      )
      if (!ta) return
      const lc = offsetToLineCol(detail.oldContent, ta.selectionStart)
      const off = lineColToOffset(detail.newContent, lc.line, lc.col)
      // Wait one tick for the bound textarea value to refresh
      queueMicrotask(() => { ta.selectionStart = ta.selectionEnd = off })
    }
    window.addEventListener('mdeditor:auto-reloaded', handler)
    return () => window.removeEventListener('mdeditor:auto-reloaded', handler)
  })
</script>

<div class="editor-stack">
  <ExternalChangeBanner {tab} />
  {#if tab.mode === 'source'}
    {#key tab.id}
      <SourceView value={tab.currentContent} oninput={onSourceInput} tabId={tab.id} />
    {/key}
  {:else if tab.kind === 'html'}
    {#key tab.id}
      <HtmlPreview html={tab.currentContent} />
    {/key}
  {:else}
    {#key tab.id}
      <RichEditor
        {tab}
        onFlush={onRichFlush}
        wrapAsCodeBlock={tab.kind === 'code' ? (tab.language ?? '') : undefined}
      />
    {/key}
  {/if}
</div>

<style>
  .editor-stack {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }
</style>
