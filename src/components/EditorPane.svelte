<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'
  import RichEditor from './RichEditor.svelte'
  import CsvEditor from './CsvEditor.svelte'
  import SourceView from './SourceView.svelte'
  import HtmlPreview from './HtmlPreview.svelte'
  import ExternalChangeBanner from './ExternalChangeBanner.svelte'
  import SyncOriginBanner from './SyncOriginBanner.svelte'
  import { offsetToLineCol, lineColToOffset } from '../lib/cursor-preserve'
  import { convertFileSrc } from '@tauri-apps/api/core'
  import { migrateTempResources, getTempDir } from '../lib/paste-resources'

  let { tab }: { tab: Tab } = $props()

  // ── Clipboard resource migration ──
  // When an untitled doc is first saved, move pasted temp resources to
  // {docBasename}_files/ and update markdown refs. Runs in the shared
  // parent so it fires regardless of which editor mode is active.
  const _mountedWithPath = !!tab.filePath
  let _didMigrate = false

  $effect(() => {
    const fp = tab.filePath
    if (_mountedWithPath || _didMigrate || !fp) return
    _didMigrate = true
    void (async () => {
      try {
        const tempDir = await getTempDir()
        const snapshot = tab.currentContent
        const updated = await migrateTempResources(snapshot, tempDir, fp)
        if (updated !== snapshot) setContent(tab.id, updated)
      } catch (e) {
        console.warn('[EditorPane] resource migration failed:', e)
      }
    })()
  })

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
  <SyncOriginBanner {tab} />
  {#if tab.kind === 'image'}
    {#key tab.id}
      <div class="image-preview-wrap">
        <img
          class="image-preview"
          src={`${convertFileSrc(tab.filePath)}?v=${tab.lastKnownMtime}`}
          alt={tab.title}
        />
      </div>
    {/key}
  {:else if tab.kind === 'spreadsheet' && tab.mode !== 'source'}
    {#key tab.id}
      <CsvEditor {tab} />
    {/key}
  {:else if tab.mode === 'source'}
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
  .image-preview-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: auto;
    background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
    padding: 24px;
  }
  .image-preview {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
</style>
