<script lang="ts">
  import type { BlockYaml } from '../blockio/yaml-schema'

  interface Props {
    container: HTMLElement | null   // the rich editor's content root
    yaml: BlockYaml | null
    badgeFormat: 'short' | 'full'
  }
  let { container, yaml, badgeFormat }: Props = $props()

  interface Frame { x: number; y: number; w: number; h: number; ids: string[] }
  let frames = $state<Frame[]>([])

  /**
   * @moraya/core wraps content in `.ProseMirror` (or `.moraya-editor`) inside
   * the host. The block-level elements (h1, p, ul, pre, …) are children of
   * THAT wrapper, not direct children of `host`. Descend one level so the
   * overlay frames each rendered block instead of one giant frame around
   * the whole document.
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
    // Naive 1:1 mapping with ids in document order; collapse 1:N when there
    // are more active blocks than DOM children by grouping extras into the
    // last seen DOM child.
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

  function badgeText(ids: string[]): string {
    if (ids.length === 0) return ''
    const head = badgeFormat === 'full' ? ids[0] : ids[0]
    return ids.length > 1 ? `${head} +${ids.length - 1}` : head
  }
</script>

<div class="mdblock-overlay">
  {#each frames as f}
    <div class="mdblock-frame"
         style:left="{f.x}px"
         style:top="{f.y}px"
         style:width="{f.w}px"
         style:height="{f.h}px">
      <div class="mdblock-badge">{badgeText(f.ids)}</div>
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
  .mdblock-badge {
    position: absolute;
    top: -10px;
    left: 6px;
    padding: 1px 6px;
    background: Canvas;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    color: color-mix(in srgb, currentColor 80%, transparent);
  }
</style>
