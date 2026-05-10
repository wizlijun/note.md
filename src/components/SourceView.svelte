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
  let lineNumbers = $derived(
    Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'),
  )

  // ---- mdblock markers overlaid in the line-number gutter ----

  let lineHeight = $state(20)
  let gutterPadTop = $state(16)
  let copiedId = $state<string | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | null = null

  $effect(() => {
    if (!textareaEl) return
    const cs = getComputedStyle(textareaEl)
    const lh = parseFloat(cs.lineHeight)
    if (!Number.isNaN(lh)) lineHeight = lh
    const pt = parseFloat(cs.paddingTop)
    if (!Number.isNaN(pt)) gutterPadTop = pt
  })

  let pageBasename = $derived((activeTab()?.filePath ?? '').replace(/^.*[\\/]/, ''))

  interface BlockMarker { id: string; line: number; lineSpan: number }
  let blockMarkers = $derived.by<BlockMarker[]>(() => {
    if (!hoverYaml || hoverYaml.active.length === 0) return []
    const sorted = [...hoverYaml.active].sort((a, b) => a.src_line - b.src_line)
    const out: BlockMarker[] = []
    for (let i = 0; i < sorted.length; i++) {
      const line = sorted[i].src_line
      const nextLine = i + 1 < sorted.length ? sorted[i + 1].src_line : lineCount + 1
      out.push({ id: sorted[i].id, line, lineSpan: Math.max(1, nextLine - line) })
    }
    return out
  })

  function citation(id: string): string { return `((${pageBasename}#${id}))` }

  function copyCitation(id: string) {
    navigator.clipboard.writeText(citation(id)).catch(() => {})
    copiedId = id
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedId = null }, 1200)
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

  let showMarkers = $derived(
    isHoverActive() && settings.mdblock.hover.showSourceGutter && hoverYaml,
  )
</script>

<div class="src">
  <div class="gutter" class:gutter-with-markers={showMarkers} bind:this={gutterEl} aria-hidden="true">
    <span class="gutter-numbers">{lineNumbers}</span>
    {#if showMarkers}
      <div class="gutter-marker-layer">
        {#each blockMarkers as m (m.id)}
          <span class="gutter-bar"
                style:top="{(m.line - 1) * lineHeight + lineHeight}px"
                style:height="{Math.max(0, (m.lineSpan - 1) * lineHeight)}px"></span>
          <button class="gutter-marker"
                  class:copied={copiedId === m.id}
                  type="button"
                  style:top="{(m.line - 1) * lineHeight + (lineHeight - 10) / 2}px"
                  title={citation(m.id)}
                  aria-label="Copy citation {citation(m.id)}"
                  onclick={() => copyCitation(m.id)}></button>
        {/each}
      </div>
    {/if}
  </div>
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
    position: relative;
  }
  .gutter-with-markers {
    /* Reserve right-side space for the marker column (≈14 px). */
    padding-right: 18px;
    min-width: calc(3.2em + 14px);
  }
  .gutter-numbers {
    display: block;
    position: relative;
  }
  .gutter-marker-layer {
    position: absolute;
    top: 16px;          /* matches .gutter padding-top; markers are content-relative */
    right: 4px;
    width: 12px;
    height: 0;          /* doesn't take layout space; children are absolutely positioned */
    pointer-events: none;
    will-change: transform;
  }
  .gutter-marker {
    position: absolute;
    right: 0;
    width: 10px;
    height: 10px;
    padding: 0;
    border: 1px solid color-mix(in srgb, currentColor 50%, transparent);
    border-radius: 2px;
    background: color-mix(in srgb, currentColor 18%, Canvas);
    cursor: pointer;
    pointer-events: auto;
    transition: background 120ms ease, transform 120ms ease;
    opacity: 1;
  }
  .gutter-marker:hover {
    background: color-mix(in srgb, currentColor 35%, Canvas);
    transform: scale(1.18);
  }
  .gutter-marker.copied {
    background: #4caf50;
    border-color: #4caf50;
  }
  .gutter-bar {
    position: absolute;
    right: 4px;
    width: 2px;
    background: color-mix(in srgb, currentColor 22%, transparent);
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
