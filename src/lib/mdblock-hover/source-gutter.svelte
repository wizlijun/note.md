<script lang="ts">
  import type { BlockYaml } from '../blockio/yaml-schema'

  interface Props {
    textarea: HTMLTextAreaElement | null
    yaml: BlockYaml | null
    pageBasename: string
  }
  let { textarea, yaml, pageBasename }: Props = $props()

  let scrollTop = $state(0)
  let totalLines = $state(0)
  let lineHeight = $state(20)
  let paddingTop = $state(0)
  let copiedId = $state<string | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | null = null

  $effect(() => {
    if (!textarea) return
    const cs = getComputedStyle(textarea)
    const lh = parseFloat(cs.lineHeight)
    if (!Number.isNaN(lh)) lineHeight = lh
    paddingTop = parseFloat(cs.paddingTop) || 0
    totalLines = textarea.value.split('\n').length

    const onScroll = () => { scrollTop = textarea!.scrollTop }
    const onInput = () => { totalLines = textarea!.value.split('\n').length }
    textarea.addEventListener('scroll', onScroll, { passive: true })
    textarea.addEventListener('input', onInput)

    const prevWrap = textarea.style.whiteSpace
    textarea.style.whiteSpace = 'pre'
    textarea.style.overflowX = 'auto'

    return () => {
      textarea!.removeEventListener('scroll', onScroll)
      textarea!.removeEventListener('input', onInput)
      textarea!.style.whiteSpace = prevWrap
    }
  })

  // Build absolute-positioned markers from yaml.active. Avoids per-row
  // height stacking (which accumulates subpixel rounding error and would
  // drift the marker by ~1 line over many lines).
  interface BlockMarker { id: string; line: number; lineSpan: number }
  let blockMarkers = $derived.by<BlockMarker[]>(() => {
    if (!yaml || yaml.active.length === 0) return []
    const sorted = [...yaml.active].sort((a, b) => a.src_line - b.src_line)
    const out: BlockMarker[] = []
    for (let i = 0; i < sorted.length; i++) {
      const line = sorted[i].src_line
      const nextLine = i + 1 < sorted.length ? sorted[i + 1].src_line : totalLines + 1
      out.push({ id: sorted[i].id, line, lineSpan: Math.max(1, nextLine - line) })
    }
    return out
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

<div class="block-gutter" style:padding-top="{paddingTop}px">
  <div class="block-gutter-inner" style:transform="translateY({-scrollTop}px)">
    {#each blockMarkers as m (m.id)}
      <span class="block-gutter-bar"
            style:top="{(m.line - 1) * lineHeight + lineHeight}px"
            style:height="{Math.max(0, (m.lineSpan - 1) * lineHeight)}px"></span>
      <button class="block-gutter-marker"
              class:copied={copiedId === m.id}
              type="button"
              style:top="{(m.line - 1) * lineHeight + (lineHeight - 10) / 2}px"
              title={citation(m.id)}
              aria-label="Copy citation {citation(m.id)}"
              onclick={() => copyCitation(m.id)}></button>
    {/each}
  </div>
</div>

<style>
  .block-gutter {
    width: 22px;
    flex-shrink: 0;
    overflow: hidden;
    border-right: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    user-select: none;
    background: color-mix(in srgb, Canvas 95%, currentColor 5%);
    position: relative;
  }
  .block-gutter-inner {
    position: relative;
    height: 100%;
    will-change: transform;
  }
  .block-gutter-marker {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 10px;
    height: 10px;
    padding: 0;
    border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
    border-radius: 2px;
    background: color-mix(in srgb, currentColor 18%, Canvas);
    cursor: pointer;
    transition: background 120ms ease, transform 120ms ease;
  }
  .block-gutter-marker:hover {
    background: color-mix(in srgb, currentColor 35%, Canvas);
    transform: translateX(-50%) scale(1.18);
  }
  .block-gutter-marker.copied {
    background: #4caf50;
    border-color: #4caf50;
  }
  .block-gutter-bar {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    width: 2px;
    background: color-mix(in srgb, currentColor 18%, transparent);
  }
</style>
