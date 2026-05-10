<script lang="ts">
  import type { BlockYaml } from '../blockio/yaml-schema'

  interface Props {
    container: HTMLElement | null   // the rich editor's host (.host element)
    yaml: BlockYaml | null
    pageBasename: string
  }
  let { container, yaml, pageBasename }: Props = $props()

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

  function recompute() {
    if (!container || !yaml) { markers = []; return }
    const root = findContentRoot(container)
    const children = Array.from(root.children) as HTMLElement[]
    const active = yaml.active
    if (children.length === 0 || active.length === 0) { markers = []; return }
    const out: Marker[] = []
    const containerRect = container.getBoundingClientRect()
    const span = Math.max(1, active.length / Math.max(1, children.length))
    for (let i = 0; i < children.length; i++) {
      const r = children[i].getBoundingClientRect()
      const startIdx = Math.floor(i * span)
      const endIdx = Math.min(active.length, Math.floor((i + 1) * span))
      const ids = active.slice(startIdx, Math.max(startIdx + 1, endIdx)).map((a) => a.id)
      if (ids.length === 0) continue
      // Convert viewport-relative top to content-relative Y so the marker
      // stays anchored as the editor scrolls. Apply translateY(-scrollTop)
      // on the wrapper to project content-relative back to viewport.
      const contentY = (r.top - containerRect.top) + container.scrollTop
      out.push({
        id: ids[0],
        siblings: ids.slice(1),
        y: contentY,
        h: r.height,
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
    const onScroll = () => {
      scrollTop = container!.scrollTop
    }
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

  function citation(id: string): string {
    return `((${pageBasename}#${id}))`
  }

  function tooltipFor(m: Marker): string {
    return [m.id, ...m.siblings].map((id) => citation(id)).join('\n')
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
    {#each markers as m}
      <div class="rich-block-row" style:top="{m.y}px" style:height="{m.h}px">
        <button class="rich-block-marker"
                class:copied={copiedId === m.id}
                type="button"
                title={tooltipFor(m)}
                aria-label="Copy citation {citation(m.id)}"
                onclick={() => copyCitation(m.id)}>
          {#if m.siblings.length > 0}
            <span class="rich-block-count">+{m.siblings.length}</span>
          {/if}
        </button>
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
  .rich-block-count {
    position: absolute;
    top: -2px;
    right: -12px;
    font-family: ui-monospace, monospace;
    font-size: 9px;
    color: color-mix(in srgb, currentColor 70%, transparent);
    background: Canvas;
    padding: 0 2px;
    border-radius: 2px;
  }
  .rich-block-bar {
    flex: 1;
    width: 2px;
    margin-top: 2px;
    background: color-mix(in srgb, currentColor 18%, transparent);
  }
</style>
