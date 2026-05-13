<script lang="ts">
  import {
    hoverStore,
    getHoverState,
    getDisplayYaml,
    loadHoverYaml,
    recomputeLiveYaml,
    isHoverActive,
  } from '../lib/mdblock-hover/hover-store.svelte'
  import { settings } from '../lib/settings.svelte'
  import { activeTab } from '../lib/tabs.svelte'
  import { cmdMdblockFollowCitationAtCursor } from '../lib/mdblock/commands'
  import { saveClipboardResource, isAttachmentUrl, basenameOf } from '../lib/paste-resources'
  import { isVideoUrl, fetchVideoInfo } from '../lib/video-links'

  let {
    value,
    oninput,
    tabId,
  }: {
    value: string
    oninput: (e: Event) => void
    tabId?: string
  } = $props()

  let textareaEl: HTMLTextAreaElement | undefined = $state()
  let highlightEl: HTMLPreElement | undefined = $state()
  let gutterEl: HTMLDivElement | undefined = $state()

  // Subscribe to hover-store version so this component re-derives when yaml updates.
  // Prefer the live preview (computed from current editor content) over the
  // persisted yaml; falls back to persisted if no live preview yet.
  let hoverYaml = $derived.by(() => {
    void hoverStore.version
    const t = activeTab()
    if (!t?.filePath) return null
    return getDisplayYaml(t.filePath)
  })

  // Trigger initial yaml load whenever the active tab changes and hover is on.
  $effect(() => {
    const t = activeTab()
    if (t?.filePath?.endsWith('.md') && isHoverActive()) {
      void loadHoverYaml(t.filePath)
    }
  })

  // Listen for citation-jump events from rich-mode pills or the source-mode
  // command, and scroll this textarea to the requested src_line.
  $effect(() => {
    function onJump(ev: Event) {
      const d = (ev as CustomEvent<{ filePath: string; srcLine: number }>).detail
      const t = activeTab()
      if (!textareaEl || !t || t.filePath !== d.filePath) return
      const lines = textareaEl.value.split('\n')
      let pos = 0
      for (let i = 0; i < d.srcLine - 1; i++) pos += lines[i].length + 1
      textareaEl.focus()
      textareaEl.setSelectionRange(pos, pos)
      const lh = parseFloat(getComputedStyle(textareaEl).lineHeight) || 20
      textareaEl.scrollTop = (d.srcLine - 1) * lh - textareaEl.clientHeight / 2
    }
    window.addEventListener('mdblock:jump', onJump)
    return () => window.removeEventListener('mdblock:jump', onJump)
  })

  async function onTextareaKeydown(ev: KeyboardEvent) {
    // Inline formatting shortcuts — independent of mdblock setting
    if (ev.metaKey || ev.ctrlKey) {
      let open = '', close = ''
      if (ev.key === 'b') { open = '**'; close = '**' }
      else if (ev.key === 'i') { open = '*'; close = '*' }
      else if (ev.key === 'h') { open = '^^'; close = '^^' }
      if (open && tabId) {
        ev.preventDefault()
        ev.stopPropagation()
        const el = textareaEl!
        const cur = el.value
        const start = el.selectionStart ?? 0
        const end = el.selectionEnd ?? 0
        const sel = cur.slice(start, end)
        // Case 1: selection itself includes the markers ("**text**" selected)
        const selWrapped = sel.startsWith(open) && sel.endsWith(close)
                        && sel.length > open.length + close.length
        // Case 2: markers are just outside the selection (selected only "text" inside **text**)
        const beforeOpen = start >= open.length && cur.slice(start - open.length, start) === open
        const afterClose = cur.slice(end, end + close.length) === close
        const outerWrapped = beforeOpen && afterClose

        if (selWrapped) {
          // Remove markers from within selection
          const inner = sel.slice(open.length, sel.length - close.length)
          setContent(tabId, cur.slice(0, start) + inner + cur.slice(end))
          requestAnimationFrame(() => el.setSelectionRange(start, start + inner.length))
        } else if (outerWrapped) {
          // Remove markers surrounding the selection
          const newStart = start - open.length
          setContent(tabId, cur.slice(0, newStart) + sel + cur.slice(end + close.length))
          requestAnimationFrame(() => el.setSelectionRange(newStart, newStart + sel.length))
        } else {
          // Wrap selection (or insert empty markers at cursor)
          setContent(tabId, cur.slice(0, start) + open + sel + close + cur.slice(end))
          requestAnimationFrame(() => el.setSelectionRange(start + open.length, end + open.length))
        }
        return
      }
    }

    // mdblock-specific shortcuts
    if (!settings.mdblock.enabled) return
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      const handled = await cmdMdblockFollowCitationAtCursor()
      if (handled) {
        ev.preventDefault()
        ev.stopPropagation()
      }
    }
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  function highlight(src: string): string {
    const lines = src.split('\n').map((line) => {
      const m = line.match(/^(#{1,6})(\s.*)?$/)
      if (m) {
        const level = m[1].length
        return `<span class="h h${level}">${escapeHtml(line)}</span>`
      }
      let out = escapeHtml(line) || ' '
      return out
    })
    // Trailing space ensures pre matches textarea height when value ends with newline
    return lines.join('\n') + '\n'
  }

  let highlighted = $derived(highlight(value))
  let lineCount = $derived(value === '' ? 1 : (value.match(/\n/g)?.length ?? 0) + 1)

  // Debounced live recompute: when the user types, schedule a chunker +
  // merge run against the persisted yaml. The result becomes the displayed
  // liveYaml until the next refresh or another edit. Block STRUCTURE
  // (new / removed / split / merged blocks) updates within ~250 ms of the
  // user pausing.
  let recomputeTimer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    void value
    const t = activeTab()
    if (!t?.filePath || !isHoverActive() || !t.filePath.endsWith('.md')) return
    if (recomputeTimer) clearTimeout(recomputeTimer)
    const filePath = t.filePath
    const cur = value
    recomputeTimer = setTimeout(() => {
      void recomputeLiveYaml(filePath, cur)
    }, 250)
  })

  // src_line → blockid for the FIRST line of each block, derived from
  // hoverYaml (which prefers liveYaml over the persisted file).
  let blockStartLines = $derived.by<Map<number, string>>(() => {
    const map = new Map<number, string>()
    if (!hoverYaml) return map
    for (const a of hoverYaml.active) map.set(a.src_line, a.id)
    return map
  })

  let copiedId = $state<string | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | null = null

  let pageBasename = $derived((activeTab()?.filePath ?? '').replace(/^.*[\\/]/, ''))

  function citation(id: string): string { return `((${pageBasename}#${id}))` }

  function copyCitation(id: string) {
    navigator.clipboard.writeText(citation(id)).catch(() => {})
    copiedId = id
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedId = null }, 1200)
  }

  function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  }

  // Render line numbers as one HTML string. Block-start lines become
  // <button> elements (full width via display:block). Other lines are
  // raw text. Newlines are preserved by white-space: pre on .gutter.
  let showMarkers = $derived(
    isHoverActive() && settings.mdblock.hover.showSourceGutter && !!hoverYaml,
  )
  let lineNumbersHtml = $derived.by(() => {
    if (!showMarkers) {
      // Plain text fallback
      return Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')
    }
    const out: string[] = []
    for (let i = 0; i < lineCount; i++) {
      const n = i + 1
      const id = blockStartLines.get(n)
      if (id) {
        const cls = id === copiedId ? 'num block-start copied' : 'num block-start'
        const cite = citation(id)
        out.push(
          `<button type="button" class="${cls}" data-blockid="${escapeAttr(id)}" ` +
          `title="${escapeAttr(cite)}" aria-label="Copy citation ${escapeAttr(cite)}">${n}</button>`,
        )
      } else {
        out.push(String(n))
      }
    }
    return out.join('\n')
  })

  function onGutterClick(ev: MouseEvent) {
    const t = ev.target as HTMLElement | null
    const btn = t?.closest<HTMLButtonElement>('button.block-start')
    if (!btn) return
    ev.preventDefault()
    ev.stopPropagation()
    const id = btn.dataset.blockid
    if (id) copyCitation(id)
  }

  function syncScroll() {
    if (!textareaEl) return
    const top = textareaEl.scrollTop
    const left = textareaEl.scrollLeft
    if (highlightEl) {
      highlightEl.scrollTop = top
      highlightEl.scrollLeft = left
    }
    if (gutterEl) gutterEl.scrollTop = top
  }

  // ── Search / Replace (textarea mode) ──

  import { findState } from '../lib/find-replace.svelte'
  import { setContent } from '../lib/tabs.svelte'

  function insertAtCursor(tabId: string, text: string) {
    if (!textareaEl) return
    const start = textareaEl.selectionStart
    const end   = textareaEl.selectionEnd
    const newValue = value.slice(0, start) + text + value.slice(end)
    setContent(tabId, newValue)
    requestAnimationFrame(() => {
      textareaEl?.setSelectionRange(start + text.length, start + text.length)
    })
  }

  async function handlePaste(event: ClipboardEvent) {
    if (!event.clipboardData) return

    // 1. 二进制 blob（截图、从浏览器复制的图片）
    const items = Array.from(event.clipboardData.items)
    const binaryItem = items.find(item => item.kind === 'file')
    if (binaryItem) {
      const file = binaryItem.getAsFile()
      if (file) {
        event.preventDefault()
        event.stopImmediatePropagation()
        try {
          const tab = activeTab()
          if (!tab) return
          const path = await saveClipboardResource(file, tab.filePath)
          const md = binaryItem.type.startsWith('image/')
            ? `![](${path})`
            : `[${basenameOf(path)}](${path})`
          insertAtCursor(tab.id, md)
        } catch (e) {
          console.warn('[SourceView] paste save failed:', e)
        }
        return
      }
    }

    // 2. URL paste (video or attachment)
    const text = event.clipboardData.getData('text/plain')?.trim()
    if (text && isVideoUrl(text) && /^https?:\/\//.test(text)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      const tab = activeTab()
      if (!tab) return
      // Insert placeholder immediately, then replace with real title
      insertAtCursor(tab.id, `[${text}](${text})`)
      fetchVideoInfo(text).then(info => {
        if (!info) return
        const t = activeTab()
        if (!t) return
        const placeholder = `[${text}](${text})`
        const real = `[${info.title}](${text})`
        if (t.currentContent.includes(placeholder)) {
          setContent(t.id, t.currentContent.replace(placeholder, real))
        }
      }).catch(() => {})
      return
    }
    if (text && isAttachmentUrl(text)) {
      try { new URL(text) } catch { return }
      event.preventDefault()
      event.stopImmediatePropagation()
      const tab = activeTab()
      if (!tab) return
      const filename = basenameOf(text.replace(/[?#].*$/, '')) || text
      insertAtCursor(tab.id, `[${filename}](${text})`)
    }
  }

  interface TextMatch { start: number; end: number }
  let searchMatches: TextMatch[] = []
  let searchIndex = -1
  let lastSearchRegex = false
  let lastSearchPattern = ''
  let lastSearchCS = false

  function escapeRegexStr(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function findMatches(query: string, cs: boolean, wholeWord: boolean, useRegex: boolean): TextMatch[] {
    if (!query) return []
    let pattern = useRegex ? query : escapeRegexStr(query)
    if (wholeWord) pattern = `\\b${pattern}\\b`
    let regex: RegExp
    try { regex = new RegExp(pattern, cs ? 'g' : 'gi') }
    catch { return [] }

    const matches: TextMatch[] = []
    let m: RegExpExecArray | null
    while ((m = regex.exec(value)) !== null) {
      if (m[0].length === 0) { regex.lastIndex++; continue }
      matches.push({ start: m.index, end: m.index + m[0].length })
      if (matches.length >= 10000) break
    }
    return matches
  }

  function scrollToTextMatch(idx: number) {
    if (!textareaEl || idx < 0 || idx >= searchMatches.length) return
    const match = searchMatches[idx]
    textareaEl.setSelectionRange(match.start, match.end)
    const lh = parseFloat(getComputedStyle(textareaEl).lineHeight) || 20
    const linesBefore = value.slice(0, match.start).split('\n').length
    const scrollTarget = (linesBefore - 3) * lh
    textareaEl.scrollTop = Math.max(0, scrollTarget)
    syncScroll()
  }

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
      return
    }
    searchMatches = findMatches(query, caseSensitive, wholeWord, useRegex)
    searchIndex = searchMatches.length > 0 ? 0 : -1
    findState.matchCount = searchMatches.length
    findState.currentMatch = searchMatches.length > 0 ? 1 : 0
    if (searchIndex >= 0) scrollToTextMatch(searchIndex)
  }

  function onFindNext() {
    if (searchMatches.length === 0) return
    searchIndex = (searchIndex + 1) % searchMatches.length
    findState.currentMatch = searchIndex + 1
    scrollToTextMatch(searchIndex)
  }

  function onFindPrev() {
    if (searchMatches.length === 0) return
    searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length
    findState.currentMatch = searchIndex + 1
    scrollToTextMatch(searchIndex)
  }

  function onFindReplace(e: Event) {
    if (searchIndex < 0 || searchIndex >= searchMatches.length) return
    const { replacement } = (e as CustomEvent).detail
    const match = searchMatches[searchIndex]
    const tab = activeTab()
    if (!tab) return

    let replaceText = replacement
    if (lastSearchRegex && lastSearchPattern) {
      try {
        const regex = new RegExp(lastSearchPattern, lastSearchCS ? '' : 'i')
        const original = value.slice(match.start, match.end)
        replaceText = original.replace(regex, replacement)
      } catch { /* literal fallback */ }
    }

    const newContent = value.slice(0, match.start) + replaceText + value.slice(match.end)
    setContent(tab.id, newContent)
    // Re-search
    setTimeout(() => onFindSearch(new CustomEvent('', { detail: {
      query: lastSearchPattern, caseSensitive: lastSearchCS,
      wholeWord: findState.wholeWord, useRegex: lastSearchRegex,
    }})), 0)
  }

  function onFindReplaceAll(e: Event) {
    const { replacement } = (e as CustomEvent).detail
    const tab = activeTab()
    if (!tab || searchMatches.length === 0) return

    let pattern = lastSearchRegex ? lastSearchPattern : escapeRegexStr(lastSearchPattern)
    if (findState.wholeWord) pattern = `\\b${pattern}\\b`
    let regex: RegExp
    try { regex = new RegExp(pattern, lastSearchCS ? 'g' : 'gi') }
    catch { return }

    const newContent = value.replace(regex, replacement)
    setContent(tab.id, newContent)
    onFindClear()
  }

  function onFindClear() {
    searchMatches = []
    searchIndex = -1
    findState.matchCount = 0
    findState.currentMatch = 0
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

  function onNewFileSelect(e: Event) {
    const { start, end } = (e as CustomEvent).detail
    if (!textareaEl) return
    setTimeout(() => {
      textareaEl!.focus()
      textareaEl!.setSelectionRange(start, end)
    }, 50)
  }
</script>

<div class="src">
  <div class="gutter"
       class:gutter-with-markers={showMarkers}
       bind:this={gutterEl}
       onclick={onGutterClick}
       role="presentation">{@html lineNumbersHtml}</div>
  <div class="host">
    <pre class="hl" bind:this={highlightEl} aria-hidden="true">{@html highlighted}</pre>
    <textarea
      bind:this={textareaEl}
      class="src-textarea"
      data-tab-id={tabId}
      {value}
      {oninput}
      onscroll={syncScroll}
      onkeydown={onTextareaKeydown}
      onpaste={handlePaste}
      spellcheck="true"
      autocapitalize="off"
    ></textarea>
  </div>
</div>

<style>
  .src {
    display: flex;
    width: 100%;
    height: 100%;
    overflow: hidden;
    box-sizing: border-box;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 14px;
    line-height: 1.6;
  }
  .gutter {
    flex-shrink: 0;
    padding: 16px 10px 16px 16px;
    color: GrayText;
    text-align: right;
    user-select: none;
    overflow: hidden;
    white-space: pre;
    background: color-mix(in srgb, CanvasText 4%, Canvas);
    box-sizing: border-box;
    min-width: 3.2em;
    opacity: 0.7;
  }
  .gutter-with-markers {
    min-width: 4em;
  }
  /* The block-start button replaces a single line's number with a
     full-width framed clickable cell.
     - `display: inline-block` keeps the element in the surrounding
       white-space: pre inline flow (using `display: block` would inject
       anonymous block breaks that consume an extra row above and below,
       throwing off every line below).
     - `width: 100%` makes the box span the gutter's content width while
       still being part of inline flow.
     - `outline` (not `border`) draws the visible frame WITHOUT taking
       layout space, so the row outer height stays exactly line-height
       and subsequent line numbers align with textarea rows. */
  .gutter :global(button.num.block-start) {
    display: inline-block;
    width: 100%;
    margin: 0;
    padding: 0 4px;
    border: 0;
    background: color-mix(in srgb, currentColor 12%, Canvas);
    color: inherit;
    font: inherit;
    text-align: right;
    cursor: pointer;
    box-sizing: border-box;
    line-height: inherit;
    outline: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    outline-offset: -1px;
    border-radius: 2px;
  }
  .gutter :global(button.num.block-start:hover) {
    background: color-mix(in srgb, currentColor 22%, Canvas);
  }
  .gutter :global(button.num.block-start.copied) {
    background: #4caf50;
    color: white;
    border-color: #4caf50;
  }
  .host {
    flex: 1;
    position: relative;
    overflow: hidden;
    min-width: 0;
    /* GPU compositing hints — promote to its own layer; isolate paint/layout */
    will-change: transform;
    transform: translateZ(0);
    contain: layout paint;
  }
  .hl,
  .host textarea {
    position: absolute;
    inset: 0;
    margin: 0;
    padding: 16px 16px 16px 12px;
    border: 0;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    box-sizing: border-box;
    white-space: pre;
    overflow: auto;
    tab-size: 4;
    word-spacing: normal;
    letter-spacing: normal;
  }
  .hl {
    pointer-events: none;
    color: CanvasText;
    background: transparent;
  }
  .hl :global(.h) {
    color: #4a90e2;
    font-weight: 500;
  }
  .hl :global(.h1) { font-weight: 600; }
  .hl :global(.h2) { font-weight: 600; }
  .host textarea {
    background: transparent;
    color: transparent;
    caret-color: CanvasText;
    outline: none;
    resize: none;
  }
  .host textarea::selection {
    background: color-mix(in srgb, #4a90e2 35%, transparent);
    color: transparent;
  }
</style>
