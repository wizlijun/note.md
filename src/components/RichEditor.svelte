<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent, activeTab } from '../lib/tabs.svelte'
  import { buildFencedBlock, stripCodeFence } from '../lib/code-fence'
  import { skin } from '../lib/skin.svelte'
  import RichOverlay from '../lib/mdblock-hover/rich-overlay.svelte'
  import {
    hoverStore,
    getHoverState,
    isHoverActive,
  } from '../lib/mdblock-hover/hover-store.svelte'
  import { settings } from '../lib/settings.svelte'

  // NOTE: @moraya/core (ProseMirror + plugins, multi-MB) is dynamically imported
  // inside onMount so it never loads when the user only uses source mode.
  type EditorInstance = {
    view: unknown
    getMarkdown(): string
    setContent(md: string): void
    destroy(): void
  }

  let {
    tab,
    onFlush,
    wrapAsCodeBlock,
  }: {
    tab: Tab
    onFlush?: (md: string) => void
    /**
     * If defined, the editor is mounted with content wrapped in a fenced block
     * (` ```<lang>...``` `) and `onChange` / `onDestroy` strip the fence before
     * propagating raw content back. Used for code-kind tabs.
     */
    wrapAsCodeBlock?: string
  } = $props()

  let host: HTMLDivElement | undefined = $state()
  let editor: EditorInstance | null = null
  let status = $state<'mounting' | 'mounted' | 'error'>('mounting')
  let errorMsg = $state<string | null>(null)

  let hoverYaml = $derived.by(() => {
    void hoverStore.version
    const t = activeTab()
    if (!t?.filePath) return null
    return getHoverState(t.filePath)?.yaml ?? null
  })
  /**
   * Last value either pushed *out* of the editor (via onChange) or pulled
   * *into* it (via inbound resync). Lets us tell "editor has user edits not
   * yet propagated" from "editor and tab.currentContent already agree".
   * Without this:
   *   - the inbound $effect would loop on every onChange round-trip;
   *   - the destroy-flush would silently overwrite externally-replaced
   *     content with the editor's pre-replacement state.
   */
  let lastSync: string | null = null

  function unwrapIfNeeded(md: string): string {
    return wrapAsCodeBlock !== undefined ? stripCodeFence(md) : md
  }

  function wrapIfNeeded(md: string): string {
    return wrapAsCodeBlock !== undefined ? buildFencedBlock(md, wrapAsCodeBlock) : md
  }

  onMount(() => {
    if (!host) {
      errorMsg = 'host element missing'
      status = 'error'
      return
    }
    const tabId = tab.id
    ;(async () => {
      try {
        const { mountRichEditor } = await import('../lib/editor-bridge')
        const inst = await mountRichEditor(host!, wrapIfNeeded(tab.currentContent), (md) => {
          const unwrapped = unwrapIfNeeded(md)
          lastSync = unwrapped
          setContent(tabId, unwrapped)
        })
        // Mark in-sync BEFORE exposing the editor: the inbound $effect runs
        // immediately on `status === 'mounted'`, and would otherwise see a
        // null lastSync and re-push the same content into a freshly-mounted
        // view (harmless but wasteful).
        lastSync = tab.currentContent
        editor = inst
        status = 'mounted'
      } catch (e) {
        console.error('[RichEditor] mount failed:', e)
        errorMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        status = 'error'
      }
    })()
  })

  // Inbound sync: when tab.currentContent is replaced from outside the
  // editor (reloadFromDisk, future autoReload paths, etc.), push it into
  // the ProseMirror view. Round-trips from our own onChange are filtered
  // by `lastSync`.
  $effect(() => {
    const target = tab.currentContent
    if (status !== 'mounted' || !editor) return
    if (target === lastSync) return
    editor.setContent(wrapIfNeeded(target))
    lastSync = target
  })

  onDestroy(() => {
    if (editor) {
      try {
        const md = editor.getMarkdown()
        const unwrapped = unwrapIfNeeded(md)
        // Skip flush when the editor is already in sync with tab.currentContent
        // — flushing then would overwrite a just-arrived external replacement
        // with the editor's pre-replacement state. Only push when there are
        // genuinely unflushed user edits (debounce hasn't fired yet).
        if (unwrapped !== lastSync) onFlush?.(unwrapped)
        editor.destroy()
      } catch (e) {
        console.warn('[RichEditor] destroy failed:', e)
      }
      editor = null
    }
  })
</script>

<div class="rich-wrap">
  {#if status === 'error'}
    <div class="diag err">[error] {errorMsg ?? 'unknown'}</div>
  {/if}
  <div class="host-shell">
    <div class="host" data-skin={skin.current} bind:this={host}></div>
    {#if isHoverActive() && settings.mdblock.hover.showRichOverlay && hoverYaml && host}
      <RichOverlay container={host} yaml={hoverYaml} badgeFormat={settings.mdblock.hover.badgeFormat} />
    {/if}
  </div>
</div>

<style>
  .rich-wrap {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
  }
  .diag {
    flex-shrink: 0;
    padding: 4px 12px;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 11px;
    background: color-mix(in srgb, CanvasText 8%, Canvas);
    color: GrayText;
  }
  .err { color: #c0392b; }
  .host-shell {
    flex: 1;
    position: relative;
    min-height: 0;
  }
  .host {
    position: absolute;
    inset: 0;
    overflow: auto;
    padding: 16px 24px;
    box-sizing: border-box;
    min-height: 200px;
    /* GPU compositing hints — promote scroll container to its own layer */
    will-change: transform;
    transform: translateZ(0);
    contain: layout paint;
  }
  .host :global(.ProseMirror),
  .host :global(.moraya-editor) {
    outline: none;
    min-height: 100%;
  }
</style>
