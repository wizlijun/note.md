<!-- src/components/daily/DailyDay.svelte — one day in the Daily Notes feed.
     Inactive: renders read-only via the SAME OutlineNode component (readonly +
     our own tree) and asks the parent to activate on click. Active: mounts the
     real OutlineEditor bound to this day's .note.md so the user edits inline.

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
  import { isEffectivelyEmptyTree, outline, bump } from '../../lib/outline/store.svelte'
  import OutlineNode from '../outline/OutlineNode.svelte'
  import OutlineEditor from '../outline/OutlineEditor.svelte'
  import { childrenOf, createTree, addNode, newId, type OutlineNode as NodeT, type OutlineTree } from '../../lib/outline/model'
  import { dayMatches } from '../../lib/daily/filter'
  import { applyFolds, setPathExpanded, noteKey, pathOfNodeIn } from '../../lib/daily/folds'

  let { date, active = false, filterQuery = '' }: { date: string; active?: boolean; filterQuery?: string } = $props()
  const dispatch = createEventDispatcher<{ requestActivate: { date: string }; linkclick: { raw: string } }>()

  let tree = $state<OutlineTree>(createTree())
  /** The tab backing the active editor (created lazily when this day activates). */
  let editorTab = $state<Tab | null>(null)
  /** When a read-only click activates this day, the clicked node's index path so we
   *  can drop straight into editing THAT node (single click = edit here). Applied
   *  once the editor has attached this day's doc to the outline singleton. */
  let pendingEditPath = $state<number[] | null>(null)

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
    const parsed = parseOutline(text)
    if (parsed.nodes.size === 0) {
      // No .note.md yet (or empty): show ONE virtual empty node that looks like a
      // real outline bullet instead of an "(empty)" placeholder. Clicking it
      // activates editing; if the user types nothing, intent-save skips creating
      // the file. This virtual node is display-only (the editor builds its own).
      addNode(parsed, { id: newId(), parentId: null, order: 0, content: '', collapsed: false, source: 'manual' })
    }
    // First level expanded, deeper folds from .notemd/outliner-folds.json.
    applyFolds(parsed, noteKey(sotvaultStore.vaultRoot, notePath))
    tree = parsed
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
      // Effectively-empty AND dirty = the user deliberately emptied the note.
      const { exists } = await import('@tauri-apps/plugin-fs')
      const existed = notePath ? await exists(notePath).catch(() => false) : false
      if (!existed) {
        // Never created → intent-save: don't create an empty .note.md.
        console.debug(`[daily] skip empty write for ${date}: intent-save (no file)`)
        return
      }
      // File existed → persist the emptying (fall through to save). Skipping here
      // would restore the old content on reload — the bug this fixes. `isDirty`
      // above guarantees this is a real user edit, not a singleton wipe.
      console.debug(`[daily] persisting emptied note for ${date}`)
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
    foldsAppliedTo = null
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

  /** Resolve an index path (from the read-only tree) against the now-attached
   *  editor tree (`outline.tree`), which has different node ids but the same
   *  structure, and return the node id at that path (null if out of range). */
  function nodeIdAtPath(path: number[]): string | null {
    let parentId: string | null = null
    let id: string | null = null
    for (const idx of path) {
      const node: NodeT | undefined = childrenOf(outline.tree, parentId)[idx]
      if (!node) return null
      id = node.id
      parentId = node.id
    }
    return id
  }

  // Single-click-to-edit: once the editor has attached THIS day's doc to the
  // outline singleton, drop straight into editing the clicked node (empty path or
  // an unresolved path → the first node). This makes one click on a read-only day
  // both activate AND enter edit, with the caret in the node you clicked.
  $effect(() => {
    void outline.version
    const docPath = outline.docPath
    if (!active || !editorTab || pendingEditPath === null || docPath !== notePath) return
    untrack(() => {
      const path = pendingEditPath
      pendingEditPath = null
      if (!path) return
      const id = (path.length ? nodeIdAtPath(path) : null) ?? childrenOf(outline.tree, null)[0]?.id ?? null
      if (id) outline.editingId = id
    })
  })

  // Roots of the read-only tree (reactive via the $state `tree`).
  const roots = $derived(childrenOf(tree, null))

  /** Read-only click on a node → activate this day and drop into editing THAT node. */
  function handleActivate(n: NodeT): void {
    pendingEditPath = pathOfNodeIn(tree, n.id)
    dispatch('requestActivate', { date })
  }

  /** A fold was toggled (read-only OR active editor). Remember the EXPANDED state in
   *  .notemd/outliner-folds.json (default is collapsed). Fold state stays OUT of the
   *  .note.md (this window sets outline.omitCollapsed) and syncs via git .notemd/.
   *  The node belongs to outline.tree when active, else our read-only `tree`. */
  function persistFold(n: NodeT): void {
    if (!notePath) return
    const t = active ? outline.tree : tree
    void setPathExpanded(
      sotvaultStore.vaultRoot ?? '',
      noteKey(sotvaultStore.vaultRoot, notePath),
      pathOfNodeIn(t, n.id),
      !n.collapsed,
    )
  }

  // Read-only fold re-render trigger: the read-only tree lives outside the outline
  // store, so a fold toggle must bump this $state to force OutlineNode to re-derive
  // (mutating node.collapsed alone isn't reliably reactive through the tree Map).
  let foldVersion = $state(0)
  function roCollapse(n: NodeT): void {
    foldVersion++
    persistFold(n)
  }

  // Once the editor has attached THIS day's doc, overlay the KV fold memory onto the
  // editor tree so the active view shows the SAME folds as the read-only view
  // (unified). One-shot per attach (guard) so it never resets in-session toggles.
  let foldsAppliedTo: string | null = null
  $effect(() => {
    void outline.version
    const docPath = outline.docPath
    if (!active || !editorTab || !notePath || docPath !== notePath) return
    if (foldsAppliedTo === notePath) return
    const np = notePath
    untrack(() => {
      applyFolds(outline.tree, noteKey(sotvaultStore.vaultRoot, np))
      foldsAppliedTo = np
      bump()
    })
  })

  // Unmount: if this day still owns a live editor (e.g. its block scrolled out of
  // the lazy feed while active, or the window closed), tear it down so no tab or
  // watcher leaks. deactivate() is idempotent/no-op without an editor.
  onMount(() => () => { foldsAppliedTo = null; void deactivate() })
</script>

<section class="day" hidden={!matchesFilter}>
  <header class="date">{date}</header>
  {#if active}
    {#if editorTab}
      {#key editorTab.id}
        <OutlineEditor
          tab={editorTab}
          embedded={true}
          onWikilink={(target) => dispatch('linkclick', { raw: `[[${target}]]` })}
          onCollapse={persistFold}
        />
      {/key}
    {/if}
  {:else}
    <!-- Read-only day: renders through the SAME OutlineNode component as the active
         editor (readonly + our own `tree`), so style/indicator/indent/padding are
         identical and collapse reuses node.collapsed. .ro-body mirrors the editor's
         `.body` width so content sits at the exact same offset. -->
    <div class="ro-body">
      {#each roots as root (root.id)}
        <OutlineNode
          node={root}
          depth={0}
          readonly
          {tree}
          {foldVersion}
          onActivate={handleActivate}
          onCollapse={roCollapse}
          onPageClick={(target) => dispatch('linkclick', { raw: `[[${target}]]` })}
        />
      {/each}
    </div>
  {/if}
</section>

<style>
  /* Continuous feed: no border/background around a day; the greyed date is the
     only separator. No background tint on the active day so read-only and edit
     look identical. Only a small horizontal window inset — no extra padding/margin
     around each outline itself. */
  .day { padding: 0 12px; }
  .date {
    font-weight: 400;
    font-size: 11px;
    color: color-mix(in srgb, CanvasText 32%, transparent);
    margin: 8px 0 0;
  }
  .ro-body { padding: 0; max-width: 860px; width: 100%; margin: 0 auto; box-sizing: border-box; }
  .empty-day {
    opacity: 0.45;
    cursor: text;
    padding: 1px 4px;
    font-family: var(--outline-font-family);
    font-size: var(--outline-font-size, 13px);
    line-height: var(--outline-line-height, 1.5);
  }
</style>
