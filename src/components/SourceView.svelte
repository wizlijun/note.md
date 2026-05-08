<script lang="ts">
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
  <div class="gutter" bind:this={gutterEl} aria-hidden="true">{lineNumbers}</div>
  <div class="host">
    <pre class="hl" bind:this={highlightEl} aria-hidden="true">{@html highlighted}</pre>
    <textarea
      bind:this={textareaEl}
      class="src-textarea"
      data-tab-id={tabId}
      {value}
      {oninput}
      onscroll={syncScroll}
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
