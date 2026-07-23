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
  import { createEventDispatcher, onMount } from 'svelte'
  import { dailyNotePath } from '../../lib/outline/daily'
  import { parseOutline } from '../../lib/outline/markdown'
  import { outlineDirs } from '../../lib/outline/dirs.svelte'
  import { sotvaultStore } from '../../lib/sotvault.svelte'
  import { tabs, openNewOutlineTab, saveTab, type Tab } from '../../lib/tabs.svelte'
  import DailyOutlineView from './DailyOutlineView.svelte'
  import OutlineEditor from '../outline/OutlineEditor.svelte'
  import { createTree, type OutlineTree } from '../../lib/outline/model'

  let { date, active = false }: { date: string; active?: boolean } = $props()
  const dispatch = createEventDispatcher<{ requestActivate: { date: string }; linkclick: { raw: string } }>()

  let tree = $state<OutlineTree>(createTree())
  /** The tab backing the active editor (created lazily when this day activates). */
  let editorTab = $state<Tab | null>(null)

  const notePath = $derived(
    sotvaultStore.vaultRoot ? dailyNotePath(sotvaultStore.vaultRoot, outlineDirs.dailynote, date) : null,
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

  /** Flush the active tab's buffer to disk (best-effort). */
  async function flush(): Promise<void> {
    if (editorTab) await saveTab(editorTab.id).catch(() => {})
  }

  // React to activation flips: on activate → make sure the editor tab is ready;
  // on deactivate → flush edits to disk and refresh the read-only tree so it
  // shows what was just saved. untrack the async work: it reads+writes $state
  // (editorTab/tree) and we don't want it re-triggering on those writes.
  let wasActive = false
  $effect(() => {
    const isActive = active
    if (isActive === wasActive) return
    wasActive = isActive
    void (async () => {
      if (isActive) {
        await ensureEditorTab()
      } else {
        await flush()
        await reload()
      }
    })()
  })

  // Unmount: flush any pending edits so nothing is lost when the day scrolls out
  // of the lazy feed or the window closes while this day is the active one.
  onMount(() => () => { void flush() })
</script>

<section class="day" class:active>
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
