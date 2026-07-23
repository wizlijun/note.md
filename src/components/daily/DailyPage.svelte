<!-- src/components/daily/DailyPage.svelte — single wiki-page view in the Daily
     Notes window. Given a page name, resolves its vault/{wikipage}/{page}.note.md
     path and mounts the real OutlineEditor bound to it.

     Persistence mirrors DailyDay exactly (this is the SAME separate webview with
     its own `tabs`/`outline` singletons): register the page's .note.md as a tab
     via `openNewOutlineTab` (deduped by path) so the editor gets the full tab
     machinery, then FLUSH to disk with `saveTab` on unmount under the same
     dirty + intent-save/wipe-guard guard (never create a blank page, never blank
     an existing one from this window).

     Wikilink clicks inside the LIVE editor are handled by OutlineEditor itself
     (onPageClick → openPageOrCreate, which opens in the MAIN editor window); this
     component therefore does not receive/forward editor link clicks, so it emits
     no events. -->
<script lang="ts">
  import { parseOutline } from '../../lib/outline/markdown'
  import { outlineDirs } from '../../lib/outline/dirs.svelte'
  import { sotvaultStore } from '../../lib/sotvault.svelte'
  import { joinPath } from '../../lib/fs'
  import { sanitizeFileName } from '../../lib/outline/slug'
  import { tabs, openNewOutlineTab, saveTab, closeTab, isDirty, type Tab } from '../../lib/tabs.svelte'
  import { untrack, onMount } from 'svelte'
  import { isEffectivelyEmptyTree } from '../../lib/outline/store.svelte'
  import OutlineEditor from '../outline/OutlineEditor.svelte'

  let { page }: { page: string } = $props()

  /** vault/{wikipage}/{page}.note.md — pages are NOT date-nested (unlike daily
   *  notes). Matches the unresolved-wikilink target in backlinks-io
   *  (openPageOrCreate): vault/{wikipage}/{sanitizeFileName(page)}.note.md. */
  const notePath = $derived(
    sotvaultStore.vaultRoot
      ? joinPath(
          joinPath(sotvaultStore.vaultRoot, outlineDirs.wikipage),
          `${sanitizeFileName(page)}.note.md`,
        )
      : null,
  )

  /** The tab backing the editor for this page. */
  let editorTab = $state<Tab | null>(null)

  /** Ensure a tab exists for this page and point `editorTab` at it. Reuse an
   *  existing tab for the same path (dedupe) so we never double-register. */
  async function ensureEditorTab(path: string): Promise<void> {
    let tab = tabs.find((x) => x.filePath === path) ?? null
    if (!tab) {
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      const text = await readTextFile(path).catch(() => '')
      await openNewOutlineTab(path, text)
      tab = tabs.find((x) => x.filePath === path) ?? null
    }
    editorTab = tab
  }

  /** Flush the active tab's buffer to disk (best-effort), honoring intent-save:
   *  an untouched blank page must NOT create a .note.md, and we never blank a
   *  non-empty file from this window (wipe-guard). Same guard order as DailyDay:
   *  1. not dirty → nothing to flush; 2. effectively-empty content → skip the
   *  write in both cases; otherwise → saveTab. */
  async function flush(tab: Tab, path: string): Promise<void> {
    if (!isDirty(tab.id)) return
    if (isEffectivelyEmptyTree(parseOutline(tab.currentContent))) {
      const { exists } = await import('@tauri-apps/plugin-fs')
      const existed = await exists(path).catch(() => false)
      console.debug(`[daily] skip empty write for page ${page}: ${existed ? 'wipe-guard' : 'intent-save'}`)
      return
    }
    await saveTab(tab.id).catch(() => {})
  }

  /** Tear down the current page's live editor: flush → close its backing tab (so
   *  no tab/watcher outlives the editor) → clear editorTab so OutlineEditor
   *  unmounts and the outline singleton is freed. Awaitable so navigation can
   *  fully release the singleton before the next page (or feed) attaches. Safe to
   *  call when no editor is owned (no-op). */
  export async function deactivate(): Promise<void> {
    const tab = editorTab
    const path = boundPath
    if (!tab || !path) { editorTab = null; return }
    await flush(tab, path)
    // flush honored intent-save/wipe-guard: an untouched/empty page stays dirty
    // (initialContent '' ≠ currentContent) so closeTab must DISCARD, not re-save.
    await closeTab(tab.id, async () => 'discard').catch(() => {})
    editorTab = null
  }

  // Load/rebind the editor tab whenever the resolved path changes. The parent
  // reuses ONE DailyPage instance across page→page navigation (the {#if page}
  // block stays mounted, only `page` changes), so on a path change we must tear
  // down the OLD tab (flush+close) BEFORE binding the new one — otherwise two
  // editors would briefly both hold the outline singleton and the old tab leaks.
  // untrack the async work: it reads+writes editorTab and must not self-retrigger.
  let boundPath: string | null = null
  $effect(() => {
    const path = notePath
    untrack(() => {
      if (path === boundPath) return
      void (async () => {
        await deactivate()        // release the previous page's editor+tab first
        boundPath = path
        if (path) await ensureEditorTab(path)
      })()
    })
  })

  // Unmount: flush pending edits AND close the tab so nothing is lost and no tab
  // or watcher leaks when the page view is replaced or the window closes.
  onMount(() => () => { void deactivate() })
</script>

<section class="page">
  <header class="title">{page}</header>
  {#if editorTab}
    {#key editorTab.id}
      <OutlineEditor tab={editorTab} />
    {/key}
  {/if}
</section>

<style>
  .page { height: 100%; display: flex; flex-direction: column; overflow: hidden; }
  .title { font-weight: 600; font-size: 13px; padding: 8px 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); flex: 0 0 auto; }
</style>
