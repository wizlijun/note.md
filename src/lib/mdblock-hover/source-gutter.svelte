<script lang="ts">
  import type { BlockYaml } from '../blockio/yaml-schema'
  import { buildLineBlockMap } from './line-block-map'

  interface Props {
    textarea: HTMLTextAreaElement | null
    yaml: BlockYaml | null
    pageBasename: string  // used to format the citation copied on click
  }
  let { textarea, yaml, pageBasename }: Props = $props()

  let scrollTop = $state(0)
  let totalLines = $state(0)
  let lineHeight = $state(20)
  let paddingTop = $state(0)
  let paddingBottom = $state(0)
  let copiedId = $state<string | null>(null)
  let copiedTimer: ReturnType<typeof setTimeout> | null = null

  $effect(() => {
    if (!textarea) return
    const cs = getComputedStyle(textarea)
    const lh = parseFloat(cs.lineHeight)
    if (!Number.isNaN(lh)) lineHeight = lh
    paddingTop = parseFloat(cs.paddingTop) || 0
    paddingBottom = parseFloat(cs.paddingBottom) || 0
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

  let lineMap = $derived(yaml ? buildLineBlockMap(yaml.active, totalLines) : new Map())

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

<div class="block-gutter"
     style:padding-top="{paddingTop}px"
     style:padding-bottom="{paddingBottom}px">
  <div class="block-gutter-inner" style:transform="translateY({-scrollTop}px)">
    {#each Array(totalLines) as _, i}
      {@const line = i + 1}
      {@const entry = lineMap.get(line)}
      <div class="block-gutter-row" style:height="{lineHeight}px">
        {#if entry?.isStart}
          <button class="block-gutter-marker"
                  class:copied={copiedId === entry.blockid}
                  type="button"
                  title={citation(entry.blockid)}
                  aria-label="Copy citation {citation(entry.blockid)}"
                  onclick={() => copyCitation(entry.blockid)}></button>
        {:else if entry}
          <span class="block-gutter-bar"></span>
        {/if}
      </div>
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
  }
  .block-gutter-inner {
    will-change: transform;
  }
  .block-gutter-row {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .block-gutter-marker {
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
    transform: scale(1.15);
  }
  .block-gutter-marker.copied {
    background: #4caf50;
    border-color: #4caf50;
  }
  .block-gutter-bar {
    display: inline-block;
    width: 2px;
    height: 100%;
    background: color-mix(in srgb, currentColor 18%, transparent);
  }
</style>
