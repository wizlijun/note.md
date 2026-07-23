<!-- src/components/daily/DailyDay.svelte — one day in the Daily Notes feed.
     Inactive: renders a lightweight read-only outline (DailyOutlineView) and asks
     the parent to activate on click. Active: mounts the real OutlineEditor bound
     to this day's .note.md so the user edits inline.

     Persistence (this is a SEPARATE webview with its own `tabs`/`outline`
     singletons): the active editor runs in OutlineEditor's `tab` mode. We register
     the day's .note.md as a tab via `openNewOutlineTab` (deduped by path) so the
     editor gets the full tab machinery (undo, dirty tracking, change-sink →
     tab.currentContent). Edits accumulate in tab.currentContent; we FLUSH them to
     disk with `saveTab` on deactivation and on unmount. That makes disk
     persistence self-contained here — it does not depend on an app-level autosave
     watcher being wired in this window. -->
<script lang="ts">
  import { createEventDispatcher, onMount, untrack } from 'svelte'
  import { dailyNotePath } from '../../lib/outline/daily'
  import { parseOutline } from '../../lib/outline/markdown'
  import { outlineDirs } from '../../lib/outline/dirs.svelte'
  import { sotvaultStore } from '../../lib/sotvault.svelte'
  import { tabs, openNewOutlineTab, saveTab, closeTab, isDirty, type Tab } from '../../lib/tabs.svelte'
  import { isEffectivelyEmptyTree } from '../../lib/outline/store.svelte'
  import DailyOutlineView from './DailyOutlineView.svelte'
  import OutlineEditor from '../outline/OutlineEditor.svelte'
  import { createTree, type OutlineTree } from '../../lib/outline/model'
  import { dayMatches } from '../../lib/daily/filter'

  let { date, active = false, filterQuery = '' }: { date: string; active?: boolean; filterQuery?: string } = $props()
  const dispatch = createEventDispatcher<{ requestActivate: { date: string }; linkclick: { raw: string } }>()

  let tree = $state<OutlineTree>(createTree())
  /** The tab backing the active editor (created lazily when this day activates). */
  let editorTab = $state<Tab | null>(null)

  const notePath = $derived(
    sotvaultStore.vaultRoot ? dailyNotePath(sotvaultStore.vaultRoot, outlineDirs.dailynote, date) : null,
  )

  // Feed-driven filtering: hide this day when a non-empty query doesn't match any
  // of its node texts. The active day is never hidden (the user is editing it);
  // an empty query matches everything (dayMatches short-circuits).
  const matchesFilter = $derived(
    active || dayMatches([...tree.nodes.values()].map((n) => n.content), filterQuery),
  )

  /** Read this day's .note.md from disk into `tree` for the read-only view. */
  export async function reload(): Promise<void> {
    if (!notePath) { tree = createTree(); return }
    const { readTextFile } = await import('@tauri-apps/plugin-fs')
    const text = await readTextFile(notePath).catch(() => '')
    tree = parseOutline(text)
  }
  onMount(reload)

  /** Ensure a tab exists for this day and point `editorTab` at it. Reuse an
   *  existing tab for the same path (dedupe) so we never double-register. */
  async function ensureEditorTab(): Promise<void> {
    if (!notePath) { editorTab = null; return }
    let tab = tabs.find((x) => x.filePath === notePath) ?? null
    if (!tab) {
      const { readTextFile } = await import('@tauri-apps/plugin-fs')
      const text = await readTextFile(notePath).catch(() => '')
      await openNewOutlineTab(notePath, text)
      tab = tabs.find((x) => x.filePath === notePath) ?? null
    }
    editorTab = tab
  }

  /** Flush the active tab's buffer to disk (best-effort), honoring intent-save:
   *  a merely-focused-but-untouched blank day must NOT create a .note.md, and we
   *  never blank a non-empty file from this window (wipe-guard).
   *
   *  Guards, in order:
   *  1. Not dirty (`currentContent === initialContent`, via `isDirty`) → no edits
   *     since activation, nothing to flush. This alone spares an untouched blank
   *     day whose file never existed (currentContent === initialContent === '').
   *  2. Effectively-empty resulting content (parse → `isEffectivelyEmptyTree`):
   *     skip the write regardless of prior existence — if the file did not exist
   *     we honor intent-save (don't create an empty file); if it DID exist we
   *     honor wipe-guard (don't blank an existing note from here).
   *  Otherwise (dirty + has content) → `saveTab` writes to disk as before. */
  async function flush(): Promise<void> {
    if (!editorTab) return
    if (!isDirty(editorTab.id)) return
    if (isEffectivelyEmptyTree(parseOutline(editorTab.currentContent))) {
      // Effectively-empty content: skip the write in BOTH cases, so we never
      // create nor blank a file. We still probe prior existence to log which rule
      // fired — did-NOT-exist → intent-save (don't create an empty .note.md);
      // DID-exist → wipe-guard (don't blank an existing note from here).
      const { exists } = await import('@tauri-apps/plugin-fs')
      const existed = notePath ? await exists(notePath).catch(() => false) : false
      console.debug(`[daily] skip empty write for ${date}: ${existed ? 'wipe-guard' : 'intent-save'}`)
      return
    }
    await saveTab(editorTab.id).catch(() => {})
  }

  /** Tear down this day's live editor: flush edits to disk (intent-save/wipe-guard
   *  aware) → close the backing tab (so no tab/watcher outlives the editor) →
   *  clear local editor state so the `{#if}` unmounts OutlineEditor, freeing the
   *  outline singleton → refresh the read-only tree to reflect what was saved.
   *
   *  This is the single-active handshake: the feed AWAITS this before mounting the
   *  incoming day's editor, guaranteeing exactly one live editor at a time. Safe to
   *  call when this day owns no editor (no-op then). */
  export async function deactivate(): Promise<void> {
    const tab = editorTab
    if (!tab) return
    await flush()
    // Flush honored intent-save/wipe-guard: an untouched/empty day stays dirty
    // (initialContent '' ≠ currentContent), so closeTab must DISCARD rather than
    // re-prompt/re-save. flush() already persisted anything worth keeping.
    await closeTab(tab.id, async () => 'discard').catch(() => {})
    editorTab = null
    await reload()
  }

  // Mount the editor only when this day becomes active. The feed awaits the
  // previous day's deactivate() (flush+detach+closeTab) BEFORE flipping our
  // `active` to true, so the outline singleton is already free when we attach.
  // We only react to the activate direction here; deactivation is method-driven
  // via deactivate(). untrack the async work (reads+writes editorTab).
  let wasActive = false
  $effect(() => {
    const isActive = active
    untrack(() => {
      if (isActive === wasActive) return
      wasActive = isActive
      if (isActive) void ensureEditorTab()
      // isActive === false is handled by deactivate() (called by the feed before
      // this flip), which already cleared editorTab; nothing to do here.
    })
  })

  // Unmount: if this day still owns a live editor (e.g. its block scrolled out of
  // the lazy feed while active, or the window closed), tear it down so no tab or
  // watcher leaks. deactivate() is idempotent/no-op without an editor.
  onMount(() => () => { void deactivate() })
</script>

<section class="day" class:active hidden={!matchesFilter}>
  <header class="date">{date}</header>
  {#if active}
    {#if editorTab}
      {#key editorTab.id}
        <OutlineEditor tab={editorTab} />
      {/key}
    {/if}
  {:else}
    <DailyOutlineView
      {tree}
      on:activate={() => dispatch('requestActivate', { date })}
      on:linkclick={(e) => dispatch('linkclick', e.detail)}
    />
  {/if}
</section>

<style>
  .day { border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent); padding: 8px 12px; }
  .date { font-weight: 600; font-size: 12px; opacity: 0.7; margin-bottom: 4px; }
  .active { background: color-mix(in srgb, CanvasText 3%, transparent); }
</style>
