<script lang="ts">
  import {
    hoverStore,
    getHoverState,
    loadHoverYaml,
    isHoverActive,
  } from '../lib/mdblock-hover/hover-store.svelte'
  import { settings } from '../lib/settings.svelte'
  import { activeTab } from '../lib/tabs.svelte'
  import { cmdMdblockFollowCitationAtCursor } from '../lib/mdblock/commands'

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
  let hoverYaml = $derived.by(() => {
    void hoverStore.version
    const t = activeTab()
    if (!t?.filePath) return null
    return getHoverState(t.filePath)?.yaml ?? null
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
      return escapeHtml(line) || ' '
    })
    // Trailing space ensures pre matches textarea height when value ends with newline
    return lines.join('\n') + '\n'
  }

  let highlighted = $derived(highlight(value))
  let lineCount = $derived(value === '' ? 1 : (value.match(/\n/g)?.length ?? 0) + 1)

  // Map src_line → blockid for the FIRST line of each block. Used to wrap
  // that line's number in a clickable box.
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
     full-width framed clickable cell. `display: block` makes it occupy
     exactly one row of line-height; positioned in the natural text flow
     so it ALWAYS lines up with the textarea content row at the same
     line number, regardless of cumulative subpixel rounding. */
  .gutter :global(button.num.block-start) {
    display: block;
    width: 100%;
    margin: 0;
    padding: 0 4px;
    border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
    border-radius: 2px;
    background: color-mix(in srgb, currentColor 12%, Canvas);
    color: inherit;
    font: inherit;
    text-align: right;
    cursor: pointer;
    box-sizing: border-box;
    line-height: inherit;
    /* The 1px borders steal 2px of vertical space. Compensate so the
       row's outer height stays exactly line-height, keeping subsequent
       line numbers aligned with textarea rows. */
    padding-top: 0;
    padding-bottom: 0;
    margin-top: -1px;
    margin-bottom: -1px;
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
