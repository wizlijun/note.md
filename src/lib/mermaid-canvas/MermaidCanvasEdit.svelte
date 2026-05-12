<script lang="ts">
  import { onDestroy } from 'svelte'
  import { CanvasOverlay } from 'mermaid-mini/components'
  import { canvasEditStore, type DiagramAdapter } from 'mermaid-mini/canvasEdit'

  let {
    adapter,
    source,
    svgRoot,
    onUpdateCode,
    onExit,
  }: {
    adapter: DiagramAdapter
    source: string
    svgRoot: SVGSVGElement | null
    onUpdateCode: (newSource: string) => void
    onExit: () => void
  } = $props()

  canvasEditStore.setEditMode(true)

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onExit()
    }
  }

  onDestroy(() => {
    canvasEditStore.setEditMode(false)
    canvasEditStore.clearSelection()
  })
</script>

<svelte:window onkeydown={handleKeydown} />

{#if svgRoot}
  <CanvasOverlay {adapter} {source} {svgRoot} onUpdateCode={onUpdateCode} />
{/if}
