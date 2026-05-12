<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent, activeTab } from '../lib/tabs.svelte'
  import { buildFencedBlock, stripCodeFence } from '../lib/code-fence'
  import { activeTheme } from '../lib/active-theme.svelte'
  import RichGutter from '../lib/mdblock-hover/rich-gutter.svelte'
  import MermaidCanvasEdit from '../lib/mermaid-canvas/MermaidCanvasEdit.svelte'
  import { getCanvasAdapter } from '../lib/mermaid-canvas/detect-diagram-type'
  import type { DiagramAdapter } from 'mermaid-mini/canvasEdit'
  import {
    hoverStore,
    getDisplayYaml,
    loadHoverYaml,
    recomputeLiveYaml,
    isHoverActive,
  } from '../lib/mdblock-hover/hover-store.svelte'
  import { settings } from '../lib/settings.svelte'

  // Reactive store of the currently active theme id, set by the theme-init
  // block in App.svelte. Default is 'default'.
  const activeThemeId = $derived(activeTheme.id)

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
    return getDisplayYaml(t.filePath)
  })

  // Auto-load yaml when this rich tab activates and mdblock is enabled.
  // SourceView has the same effect; without it here, opening a doc
  // directly into rich mode wouldn't trigger any load until the user
  // toggles to source or runs Cmd+Shift+B manually.
  $effect(() => {
    const t = activeTab()
    if (t?.filePath?.endsWith('.md') && isHoverActive()) {
      void loadHoverYaml(t.filePath)
    }
  })

  // Debounced live recompute when the rich editor's content changes.
  // Mirrors SourceView so users editing in rich also see structural
  // updates (new blocks, removed blocks, line shifts) within ~250 ms
  // of pausing typing.
  let richRecomputeTimer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    void tab.currentContent
    if (!tab.filePath || !isHoverActive() || !tab.filePath.endsWith('.md')) return
    if (richRecomputeTimer) clearTimeout(richRecomputeTimer)
    const filePath = tab.filePath
    const cur = tab.currentContent
    richRecomputeTimer = setTimeout(() => {
      void recomputeLiveYaml(filePath, cur)
    }, 250)
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

  // --- Mermaid canvas edit state ---
  let canvasEdit = $state<{
    wrapper: HTMLElement
    adapter: DiagramAdapter
    source: string
    svgRoot: SVGSVGElement | null
  } | null>(null)
  let canvasEditObserver: MutationObserver | null = null

  function startObservingSvg(wrapper: HTMLElement) {
    stopObservingSvg()
    const previewEl = wrapper.querySelector('.mermaid-preview')
    if (!previewEl) return
    canvasEditObserver = new MutationObserver(() => {
      if (!canvasEdit) return
      const newSvg = wrapper.querySelector('.mermaid-preview svg') as SVGSVGElement | null
      if (newSvg && newSvg !== canvasEdit.svgRoot) {
        canvasEdit = { ...canvasEdit, svgRoot: newSvg }
      }
    })
    canvasEditObserver.observe(previewEl, { childList: true, subtree: true })
  }

  function stopObservingSvg() {
    canvasEditObserver?.disconnect()
    canvasEditObserver = null
  }

  function handleMermaidEditIntercept(e: MouseEvent) {
    const target = e.target as HTMLElement | null
    if (!target) return

    const preview = target.closest('.mermaid-preview') as HTMLElement | null
    const toggleBtn = target.closest('.mermaid-toggle-btn') as HTMLElement | null

    if (!preview && !toggleBtn) return

    // For toggle button, only intercept when switching TO edit mode (button says "Edit")
    if (toggleBtn && !toggleBtn.textContent?.includes('Edit')) return

    const wrapper = target.closest('.code-block-wrapper') as HTMLElement | null
    if (!wrapper) return

    const codeEl = wrapper.querySelector('code.code-block-code') as HTMLElement | null
    if (!codeEl) return

    const source = codeEl.textContent || ''
    const adapter = getCanvasAdapter(source)
    if (!adapter) return

    // Has canvas adapter — intercept and enter graphical edit mode
    e.stopPropagation()
    e.preventDefault()

    const svgEl = wrapper.querySelector('.mermaid-preview svg') as SVGSVGElement | null
    canvasEdit = { wrapper, adapter, source, svgRoot: svgEl }
    startObservingSvg(wrapper)
  }

  function handleCanvasUpdateCode(newSource: string) {
    if (!canvasEdit || !editor) return
    const view = (editor as any).view
    if (!view) return

    const wrapper = canvasEdit.wrapper
    const pos = view.posAtDOM(wrapper, 0)
    const node = view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== 'code_block') return

    const tr = view.state.tr.replaceWith(
      pos + 1,
      pos + 1 + node.content.size,
      node.type.schema.text(newSource),
    )
    view.dispatch(tr)
    canvasEdit = { ...canvasEdit, source: newSource }
  }

  function exitCanvasEdit() {
    stopObservingSvg()
    canvasEdit = null
  }

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

    host.addEventListener('mousedown', handleMermaidEditIntercept, true)

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
    stopObservingSvg()
    host?.removeEventListener('mousedown', handleMermaidEditIntercept, true)
    if (editor) {
      try {
        const md = editor.getMarkdown()
        const unwrapped = unwrapIfNeeded(md)
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
  <div class="rich-pane">
    {#if isHoverActive() && settings.mdblock.hover.showRichOverlay && hoverYaml && host}
      <RichGutter container={host}
                  yaml={hoverYaml}
                  source={tab.currentContent}
                  pageBasename={(activeTab()?.filePath ?? '').replace(/^.*[\\/]/, '')} />
    {/if}
    <div class="host" data-theme={activeThemeId} bind:this={host}></div>
  </div>
  {#if canvasEdit}
    <MermaidCanvasEdit
      adapter={canvasEdit.adapter}
      source={canvasEdit.source}
      svgRoot={canvasEdit.svgRoot}
      onUpdateCode={handleCanvasUpdateCode}
      onExit={exitCanvasEdit} />
  {/if}
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
  .rich-pane {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .host {
    flex: 1;
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
