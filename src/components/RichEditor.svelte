<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent, activeTab } from '../lib/tabs.svelte'
  import { buildFencedBlock, stripCodeFence } from '../lib/code-fence'
  import { activeTheme } from '../lib/active-theme.svelte'
  import RichGutter from '../lib/mdblock-hover/rich-gutter.svelte'
  import {
    hoverStore,
    getDisplayYaml,
    loadHoverYaml,
    recomputeLiveYaml,
    isHoverActive,
  } from '../lib/mdblock-hover/hover-store.svelte'
  import { settings } from '../lib/settings.svelte'
  import '../lib/styles/attachment.css'
  import { saveClipboardResource, isAttachmentUrl } from '../lib/paste-resources'
  import { insertImageAtCursor, insertAttachmentLink } from '../lib/attachment-insert'
  import type { EditorView } from 'prosemirror-view'

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

  // ── Search / Replace state ──
  interface MatchPos { from: number; to: number }
  let searchMatches: MatchPos[] = []
  let searchIndex = -1
  let lastSearchRegex = false
  let lastSearchPattern = ''
  let lastSearchCS = false

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
  let _pmEl: HTMLElement | null = null

  async function handlePaste(event: ClipboardEvent) {
    if (!editor || !event.clipboardData) return

    // ── 1. Binary blob in clipboard (screenshot, copied image from browser) ──
    const items = Array.from(event.clipboardData.items)
    const binaryItem = items.find(item => item.kind === 'file')
    if (binaryItem) {
      const file = binaryItem.getAsFile()
      if (file) {
        event.preventDefault()
        event.stopImmediatePropagation()
        try {
          const path = await saveClipboardResource(file, tab.filePath)
          const view = editor.view as unknown as EditorView
          if (binaryItem.type.startsWith('image/')) {
            insertImageAtCursor(view, path)
          } else {
            insertAttachmentLink(view, path)
          }
        } catch (e) {
          console.warn('[RichEditor] paste save failed:', e)
        }
        return
      }
    }

    // ── 2. URL with attachment extension ──
    const text = event.clipboardData.getData('text/plain')?.trim()
    if (text && isAttachmentUrl(text)) {
      try { new URL(text) } catch { return }
      event.preventDefault()
      event.stopImmediatePropagation()
      const view = editor.view as unknown as EditorView
      insertAttachmentLink(view, text)
    }
    // 3. Everything else: let ProseMirror handle
  }

  function unwrapIfNeeded(md: string): string {
    return wrapAsCodeBlock !== undefined ? stripCodeFence(md) : md
  }

  function wrapIfNeeded(md: string): string {
    return wrapAsCodeBlock !== undefined ? buildFencedBlock(md, wrapAsCodeBlock) : md
  }

  // ── Search engine (ProseMirror decorations) ──

  function buildFlatText(doc: any): { text: string; offsets: number[] } {
    const parts: string[] = []
    const offsets: number[] = []
    let first = true
    doc.descendants((node: any, pos: number) => {
      if (node.isBlock && node.isTextblock) {
        if (!first) {
          parts.push('\n')
          offsets.push(-1)
        }
        first = false
        node.forEach((child: any, childOffset: number) => {
          if (child.isText && child.text) {
            for (let i = 0; i < child.text.length; i++) {
              parts.push(child.text[i])
              offsets.push(pos + 1 + childOffset + i)
            }
          }
        })
        return false
      }
      return true
    })
    return { text: parts.join(''), offsets }
  }

  function flatRangeToPmRanges(offsets: number[], start: number, end: number): MatchPos[] {
    const ranges: MatchPos[] = []
    let segStart = -1
    for (let i = start; i < end; i++) {
      if (offsets[i] === -1) {
        if (segStart >= 0) {
          ranges.push({ from: segStart, to: offsets[i - 1] + 1 })
          segStart = -1
        }
      } else {
        if (segStart < 0) segStart = offsets[i]
      }
    }
    if (segStart >= 0 && end > start) {
      for (let i = end - 1; i >= start; i--) {
        if (offsets[i] !== -1) {
          ranges.push({ from: segStart, to: offsets[i] + 1 })
          break
        }
      }
    }
    return ranges
  }

  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function findTextMatches(query: string, cs: boolean, wholeWord: boolean, useRegex: boolean): MatchPos[] {
    if (!editor || !query) return []
    const view = editor.view as any
    const { text: flatText, offsets } = buildFlatText(view.state.doc)

    let pattern = useRegex ? query : escapeRegex(query)
    if (wholeWord) pattern = `\\b${pattern}\\b`
    let regex: RegExp
    try {
      regex = new RegExp(pattern, cs ? 'g' : 'gi')
    } catch { return [] }

    const matches: MatchPos[] = []
    let m: RegExpExecArray | null
    while ((m = regex.exec(flatText)) !== null) {
      if (m[0].length === 0) { regex.lastIndex++; continue }
      const pmRanges = flatRangeToPmRanges(offsets, m.index, m.index + m[0].length)
      if (pmRanges.length > 0) {
        matches.push({ from: pmRanges[0].from, to: pmRanges[pmRanges.length - 1].to })
      }
      if (matches.length >= 10000) break
    }
    return matches
  }

  let _pmView: typeof import('prosemirror-view') | null = null
  let _pmState: typeof import('prosemirror-state') | null = null

  async function getPmView() {
    if (!_pmView) _pmView = await import('prosemirror-view')
    return _pmView
  }
  async function getPmState() {
    if (!_pmState) _pmState = await import('prosemirror-state')
    return _pmState
  }

  async function applySearchDecorations(matches: MatchPos[], activeIdx: number) {
    if (!editor) return
    const view = editor.view as any
    const { Decoration, DecorationSet } = await getPmView()
    if (matches.length === 0) {
      view.setProps({ decorations: () => DecorationSet.empty })
      return
    }
    const decos = matches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class: i === activeIdx ? 'search-highlight-current' : 'search-highlight',
      })
    )
    const decoSet = DecorationSet.create(view.state.doc, decos)
    view.setProps({ decorations: () => decoSet })
  }

  async function scrollToMatch(idx: number) {
    if (!editor || idx < 0 || idx >= searchMatches.length) return
    const view = editor.view as any
    const { TextSelection } = await getPmState()
    const match = searchMatches[idx]
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to))
    tr.scrollIntoView()
    view.dispatch(tr)

    requestAnimationFrame(() => {
      try {
        const coords = view.coordsAtPos(match.from)
        const wrapper = host as HTMLElement | null
        if (!wrapper) return
        const rect = wrapper.getBoundingClientRect()
        if (coords.top < rect.top || coords.bottom > rect.bottom) {
          wrapper.scrollTop += coords.top - rect.top - rect.height / 3
        }
      } catch { /* ignore */ }
    })
  }

  function getMatchedFlatText(doc: any, match: MatchPos): string {
    const parts: string[] = []
    doc.nodesBetween(match.from, match.to, (node: any, pos: number) => {
      if (node.isTextblock) {
        if (parts.length > 0) parts.push('\n')
        const startInNode = Math.max(match.from - pos - 1, 0)
        const endInNode = Math.min(match.to - pos - 1, node.content.size)
        if (endInNode > startInNode) {
          parts.push(node.textBetween(startInNode, endInNode))
        }
        return false
      }
      return true
    })
    return parts.join('')
  }

  import { findState } from '../lib/find-replace.svelte'

  function onFindSearch(e: Event) {
    const { query, caseSensitive, wholeWord, useRegex } = (e as CustomEvent).detail
    lastSearchPattern = query
    lastSearchCS = caseSensitive
    lastSearchRegex = useRegex
    if (!query) {
      searchMatches = []
      searchIndex = -1
      findState.matchCount = 0
      findState.currentMatch = 0
      void applySearchDecorations([], -1)
      return
    }
    searchMatches = findTextMatches(query, caseSensitive, wholeWord, useRegex)
    searchIndex = searchMatches.length > 0 ? 0 : -1
    findState.matchCount = searchMatches.length
    findState.currentMatch = searchMatches.length > 0 ? 1 : 0
    void applySearchDecorations(searchMatches, searchIndex)
    if (searchIndex >= 0) void scrollToMatch(searchIndex)
  }

  function onFindNext() {
    if (searchMatches.length === 0) return
    searchIndex = (searchIndex + 1) % searchMatches.length
    findState.currentMatch = searchIndex + 1
    void applySearchDecorations(searchMatches, searchIndex)
    void scrollToMatch(searchIndex)
  }

  function onFindPrev() {
    if (searchMatches.length === 0) return
    searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length
    findState.currentMatch = searchIndex + 1
    void applySearchDecorations(searchMatches, searchIndex)
    void scrollToMatch(searchIndex)
  }

  function onFindReplace(e: Event) {
    if (!editor || searchIndex < 0 || searchIndex >= searchMatches.length) return
    const { replacement } = (e as CustomEvent).detail
    const view = editor.view as any
    const match = searchMatches[searchIndex]

    let replaceText = replacement
    if (lastSearchRegex && lastSearchPattern) {
      try {
        const regex = new RegExp(lastSearchPattern, lastSearchCS ? '' : 'i')
        const matchedText = getMatchedFlatText(view.state.doc, match)
        replaceText = matchedText.replace(regex, replacement)
      } catch { /* literal fallback */ }
    }

    const tr = replaceText
      ? view.state.tr.replaceWith(match.from, match.to, view.state.schema.text(replaceText))
      : view.state.tr.delete(match.from, match.to)
    view.dispatch(tr)

    // Re-search after replace
    onFindSearch(new CustomEvent('', { detail: {
      query: lastSearchPattern, caseSensitive: lastSearchCS,
      wholeWord: findState.wholeWord, useRegex: lastSearchRegex,
    }}))
  }

  function onFindReplaceAll(e: Event) {
    if (!editor || searchMatches.length === 0) return
    const { replacement } = (e as CustomEvent).detail
    const view = editor.view as any
    let tr = view.state.tr

    if (lastSearchRegex && lastSearchPattern) {
      try {
        const regex = new RegExp(lastSearchPattern, lastSearchCS ? '' : 'i')
        for (let i = searchMatches.length - 1; i >= 0; i--) {
          const matchedText = getMatchedFlatText(view.state.doc, searchMatches[i])
          const replaceText = matchedText.replace(regex, replacement)
          tr = replaceText
            ? tr.replaceWith(searchMatches[i].from, searchMatches[i].to, view.state.schema.text(replaceText))
            : tr.delete(searchMatches[i].from, searchMatches[i].to)
        }
      } catch {
        for (let i = searchMatches.length - 1; i >= 0; i--) {
          tr = replacement
            ? tr.replaceWith(searchMatches[i].from, searchMatches[i].to, view.state.schema.text(replacement))
            : tr.delete(searchMatches[i].from, searchMatches[i].to)
        }
      }
    } else {
      for (let i = searchMatches.length - 1; i >= 0; i--) {
        tr = replacement
          ? tr.replaceWith(searchMatches[i].from, searchMatches[i].to, view.state.schema.text(replacement))
          : tr.delete(searchMatches[i].from, searchMatches[i].to)
      }
    }
    view.dispatch(tr)
    onFindClear()
  }

  function onFindClear() {
    searchMatches = []
    searchIndex = -1
    findState.matchCount = 0
    findState.currentMatch = 0
    void applySearchDecorations([], -1)
  }

  $effect(() => {
    window.addEventListener('mdeditor:find-search', onFindSearch)
    window.addEventListener('mdeditor:find-next', onFindNext)
    window.addEventListener('mdeditor:find-prev', onFindPrev)
    window.addEventListener('mdeditor:find-replace', onFindReplace)
    window.addEventListener('mdeditor:find-replace-all', onFindReplaceAll)
    window.addEventListener('mdeditor:find-clear', onFindClear)
    window.addEventListener('mdeditor:new-file-select', onNewFileSelect)
    return () => {
      window.removeEventListener('mdeditor:find-search', onFindSearch)
      window.removeEventListener('mdeditor:find-next', onFindNext)
      window.removeEventListener('mdeditor:find-prev', onFindPrev)
      window.removeEventListener('mdeditor:find-replace', onFindReplace)
      window.removeEventListener('mdeditor:find-replace-all', onFindReplaceAll)
      window.removeEventListener('mdeditor:find-clear', onFindClear)
      window.removeEventListener('mdeditor:new-file-select', onNewFileSelect)
    }
  })

  async function onNewFileSelect(_e: Event) {
    if (!editor || status !== 'mounted') return
    const view = editor.view as any
    const { TextSelection, AllSelection } = await getPmState()
    setTimeout(() => {
      try {
        const doc = view.state.doc
        // Select everything after the first block (heading)
        const firstBlock = doc.firstChild
        if (!firstBlock) return
        const from = firstBlock.nodeSize
        const to = doc.content.size
        if (from >= to) return
        const tr = view.state.tr.setSelection(TextSelection.create(doc, from, to))
        view.dispatch(tr)
        view.focus()
      } catch { /* ignore */ }
    }, 100)
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
        _pmEl = host!.querySelector('.ProseMirror') as HTMLElement | null
        _pmEl?.addEventListener('paste', handlePaste as EventListener, true)
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
    _pmEl?.removeEventListener('paste', handlePaste as EventListener, true)
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
  <div class="rich-pane">
    {#if isHoverActive() && settings.mdblock.hover.showRichOverlay && hoverYaml && host}
      <RichGutter container={host}
                  yaml={hoverYaml}
                  source={tab.currentContent}
                  pageBasename={(activeTab()?.filePath ?? '').replace(/^.*[\\/]/, '')} />
    {/if}
    <div class="host" data-theme={activeThemeId} bind:this={host}></div>
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
