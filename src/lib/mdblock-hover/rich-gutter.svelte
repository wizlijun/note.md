<script lang="ts">
  import type { BlockYaml } from '../blockio/yaml-schema'

  interface Props {
    container: HTMLElement | null   // the rich editor's host (.host element)
    yaml: BlockYaml | null
    source: string                  // raw source markdown — needed to map src_line → DOM child
    pageBasename: string
  }
  let { container, yaml, source, pageBasename }: Props = $props()

  interface Marker { id: string; y: number; h: number; siblings: string[] }
  let markers = $state<Marker[]>([])
  let scrollTop = $state(0)
  let copiedId = $state<string | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | null = null

  function findContentRoot(host: HTMLElement): HTMLElement {
    return (
      (host.querySelector('.ProseMirror') as HTMLElement | null) ??
      (host.querySelector('.moraya-editor') as HTMLElement | null) ??
      host
    )
  }

  /**
   * Walk the source markdown line-by-line and emit the 1-based start line
   * of every "top-level construct" — heading, paragraph, list (the whole
   * group, not each item), code fence, blockquote, hr.
   *
   * The result's length is the expected number of top-level DOM children
   * the rich editor produces; result[i] = source line where construct i
   * begins. Front-matter is *not* re-detected here because the rich
   * editor already strips it on render.
   */
  function topLevelStartLines(src: string): number[] {
    const lines = src.split('\n')
    const out: number[] = []
    let inFence = false
    let inGroup: 'paragraph' | 'list' | 'blockquote' | null = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1
      const trimmed = line.trimStart()
      if (/^```/.test(trimmed)) {
        if (!inFence) { out.push(lineNum); inFence = true }
        else { inFence = false }
        inGroup = null
        continue
      }
      if (inFence) continue
      if (line.trim() === '') { inGroup = null; continue }
      if (/^#{1,6}\s/.test(trimmed)) { out.push(lineNum); inGroup = null; continue }
      if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) { out.push(lineNum); inGroup = null; continue }
      if (/^[-*+]\s|^\d+\.\s/.test(trimmed)) {
        if (inGroup !== 'list') { out.push(lineNum); inGroup = 'list' }
        continue
      }
      if (/^>/.test(trimmed)) {
        if (inGroup !== 'blockquote') { out.push(lineNum); inGroup = 'blockquote' }
        continue
      }
      if (inGroup !== 'paragraph') { out.push(lineNum); inGroup = 'paragraph' }
    }
    return out
  }

  /**
   * For each yaml block, find the index range [startIdx, endIdx) of
   * top-level constructs that fall within [src_line, src_end_line].
   * Then look up the corresponding DOM children for absolute Y positions.
   */
  function recompute() {
    if (!container || !yaml) { markers = []; return }
    const root = findContentRoot(container)
    const children = Array.from(root.children) as HTMLElement[]
    if (children.length === 0 || yaml.active.length === 0) { markers = []; return }

    const tops = topLevelStartLines(source)
    if (tops.length === 0) { markers = []; return }

    // Map from a 1-based source line to the index of the top-level construct
    // that starts at-or-before it. Greedy linear scan.
    function topIdxForLine(line: number): number {
      let lo = 0
      let hi = tops.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (tops[mid] <= line) lo = mid
        else hi = mid - 1
      }
      return lo
    }

    const containerRect = container.getBoundingClientRect()
    const sortedActive = [...yaml.active].sort((a, b) => a.src_line - b.src_line)
    const out: Marker[] = []
    for (let bi = 0; bi < sortedActive.length; bi++) {
      const block = sortedActive[bi]
      const nextLine = bi + 1 < sortedActive.length ? sortedActive[bi + 1].src_line : Number.POSITIVE_INFINITY
      const startIdx = topIdxForLine(block.src_line)
      // End just before the next block's first top-level construct
      let endIdx: number
      if (nextLine === Number.POSITIVE_INFINITY) {
        endIdx = tops.length - 1
      } else {
        endIdx = Math.max(startIdx, topIdxForLine(nextLine) - 1)
        if (endIdx < 0) endIdx = startIdx
      }
      // Clamp to actual DOM children (protects against parser/render mismatch)
      const ds = Math.min(startIdx, children.length - 1)
      const de = Math.min(endIdx, children.length - 1)
      const startEl = children[ds]
      const endEl = children[de]
      if (!startEl || !endEl) continue
      const sr = startEl.getBoundingClientRect()
      const er = endEl.getBoundingClientRect()
      // Convert viewport-relative to content-relative so the marker stays
      // anchored when the editor scrolls.
      const contentTop = sr.top - containerRect.top + container.scrollTop
      const contentBottom = er.bottom - containerRect.top + container.scrollTop
      out.push({
        id: block.id,
        siblings: [],
        y: contentTop,
        h: Math.max(0, contentBottom - contentTop),
      })
    }
    markers = out
  }

  let observer: MutationObserver | null = null
  let raf = 0

  $effect(() => {
    if (!container) return
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(recompute)
    }
    const onScroll = () => { scrollTop = container!.scrollTop }
    observer = new MutationObserver(schedule)
    observer.observe(container, { childList: true, subtree: true, characterData: true })
    schedule()
    window.addEventListener('resize', schedule)
    container.addEventListener('scroll', onScroll, { passive: true })
    container.addEventListener('scroll', schedule, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      container?.removeEventListener('scroll', onScroll)
      container?.removeEventListener('scroll', schedule)
      cancelAnimationFrame(raf)
    }
  })

  // Recompute when source / yaml changes (e.g. user edits the doc, or
  // commands.refresh writes a new yaml).
  $effect(() => {
    void source
    void yaml
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(recompute)
  })

  function citation(id: string): string {
    return `((${pageBasename}#${id}))`
  }

  function copyCitation(id: string) {
    navigator.clipboard.writeText(citation(id)).catch(() => {})
    copiedId = id
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedId = null }, 1200)
  }
</script>

<div class="rich-block-gutter">
  <div class="rich-block-gutter-inner" style:transform="translateY({-scrollTop}px)">
    {#each markers as m (m.id)}
      <div class="rich-block-row" style:top="{m.y}px" style:height="{m.h}px">
        <button class="rich-block-marker"
                class:copied={copiedId === m.id}
                type="button"
                title={citation(m.id)}
                aria-label="Copy citation {citation(m.id)}"
                onclick={() => copyCitation(m.id)}></button>
        <span class="rich-block-bar"></span>
      </div>
    {/each}
  </div>
</div>

<style>
  .rich-block-gutter {
    width: 22px;
    flex-shrink: 0;
    overflow: hidden;
    border-right: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    user-select: none;
    background: color-mix(in srgb, Canvas 95%, currentColor 5%);
    position: relative;
  }
  .rich-block-gutter-inner {
    will-change: transform;
    position: relative;
    height: 100%;
  }
  .rich-block-row {
    position: absolute;
    left: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    pointer-events: none;
  }
  .rich-block-marker {
    width: 10px;
    height: 10px;
    flex-shrink: 0;
    padding: 0;
    border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
    border-radius: 2px;
    background: color-mix(in srgb, currentColor 18%, Canvas);
    cursor: pointer;
    margin-top: 4px;
    transition: background 120ms ease, transform 120ms ease;
    position: relative;
    pointer-events: auto;
  }
  .rich-block-marker:hover {
    background: color-mix(in srgb, currentColor 35%, Canvas);
    transform: scale(1.18);
  }
  .rich-block-marker.copied {
    background: #4caf50;
    border-color: #4caf50;
  }
  .rich-block-bar {
    flex: 1;
    width: 2px;
    margin-top: 2px;
    background: color-mix(in srgb, currentColor 18%, transparent);
  }
</style>
