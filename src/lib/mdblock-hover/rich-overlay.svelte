<script lang="ts">
  import type { BlockYaml } from '../blockio/yaml-schema'

  interface Props {
    container: HTMLElement | null   // the rich editor's content root
    yaml: BlockYaml | null
    pageBasename: string
  }
  let { container, yaml, pageBasename }: Props = $props()

  interface Frame { x: number; y: number; w: number; h: number; ids: string[] }
  let frames = $state<Frame[]>([])
  let copiedId = $state<string | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * @moraya/core wraps content in `.ProseMirror` (or `.moraya-editor`) inside
   * the host. The block-level elements (h1, p, ul, pre, …) are children of
   * THAT wrapper, not direct children of `host`. Descend one level so the
   * overlay frames each rendered block instead of one giant frame.
   */
  function findContentRoot(host: HTMLElement): HTMLElement {
    return (
      (host.querySelector('.ProseMirror') as HTMLElement | null) ??
      (host.querySelector('.moraya-editor') as HTMLElement | null) ??
      host
    )
  }

  function recompute() {
    if (!container || !yaml) { frames = []; return }
    const root = findContentRoot(container)
    const children = Array.from(root.children) as HTMLElement[]
    const active = yaml.active
    if (children.length === 0 || active.length === 0) { frames = []; return }
    const out: Frame[] = []
    const containerRect = container.getBoundingClientRect()
    const span = Math.max(1, active.length / Math.max(1, children.length))
    for (let i = 0; i < children.length; i++) {
      const r = children[i].getBoundingClientRect()
      const startIdx = Math.floor(i * span)
      const endIdx = Math.min(active.length, Math.floor((i + 1) * span))
      const ids = active.slice(startIdx, Math.max(startIdx + 1, endIdx)).map((a) => a.id)
      out.push({
        x: r.left - containerRect.left,
        y: r.top - containerRect.top,
        w: r.width,
        h: r.height,
        ids,
      })
    }
    frames = out
  }

  let observer: MutationObserver | null = null
  let raf = 0

  $effect(() => {
    if (!container) return
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(recompute)
    }
    observer = new MutationObserver(schedule)
    observer.observe(container, { childList: true, subtree: true, characterData: true })
    schedule()
    window.addEventListener('resize', schedule)
    container.addEventListener('scroll', schedule, { passive: true })
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', schedule)
      container?.removeEventListener('scroll', schedule)
      cancelAnimationFrame(raf)
    }
  })

  function citation(id: string): string {
    return `((${pageBasename}#${id}))`
  }

  function tooltipFor(ids: string[]): string {
    if (ids.length === 0) return ''
    if (ids.length === 1) return citation(ids[0])
    return ids.map((id) => citation(id)).join('\n')
  }

  function copyCitation(id: string) {
    navigator.clipboard.writeText(citation(id)).catch(() => {})
    copiedId = id
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copiedId = null }, 1200)
  }
</script>

<div class="mdblock-overlay">
  {#each frames as f}
    <div class="mdblock-frame"
         style:left="{f.x}px"
         style:top="{f.y}px"
         style:width="{f.w}px"
         style:height="{f.h}px">
      <button class="mdblock-marker"
              class:copied={f.ids.length > 0 && copiedId === f.ids[0]}
              type="button"
              title={tooltipFor(f.ids)}
              aria-label={f.ids.length > 0 ? `Copy citation ${citation(f.ids[0])}` : ''}
              onclick={() => f.ids.length > 0 && copyCitation(f.ids[0])}>
        {#if f.ids.length > 1}
          <span class="mdblock-marker-count">+{f.ids.length - 1}</span>
        {/if}
      </button>
    </div>
  {/each}
</div>

<style>
  .mdblock-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .mdblock-frame {
    position: absolute;
    border: 1px dashed color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 3px;
  }
  .mdblock-marker {
    position: absolute;
    top: -7px;
    left: -7px;
    width: 12px;
    height: 12px;
    padding: 0;
    border: 1px solid color-mix(in srgb, currentColor 50%, transparent);
    border-radius: 3px;
    background: color-mix(in srgb, currentColor 18%, Canvas);
    cursor: pointer;
    pointer-events: auto;
    transition: background 120ms ease, transform 120ms ease;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .mdblock-marker:hover {
    background: color-mix(in srgb, currentColor 35%, Canvas);
    transform: scale(1.18);
  }
  .mdblock-marker.copied {
    background: #4caf50;
    border-color: #4caf50;
  }
  .mdblock-marker-count {
    position: absolute;
    top: -2px;
    right: -10px;
    font-family: ui-monospace, monospace;
    font-size: 9px;
    color: color-mix(in srgb, currentColor 70%, transparent);
    background: Canvas;
    padding: 0 2px;
    border-radius: 2px;
  }
</style>
