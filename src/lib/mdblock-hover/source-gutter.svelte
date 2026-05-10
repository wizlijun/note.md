<script lang="ts">
  import type { BlockYaml } from '../blockio/yaml-schema'
  import { buildLineBlockMap } from './line-block-map'

  interface Props {
    textarea: HTMLTextAreaElement | null
    yaml: BlockYaml | null
    badgeFormat: 'short' | 'full'
  }
  let { textarea, yaml, badgeFormat }: Props = $props()

  let scrollTop = $state(0)
  let totalLines = $state(0)
  let lineHeight = $state(20)
  let fontFamily = $state('ui-monospace, monospace')
  let fontSize = $state('14px')

  // Recompute geometry when textarea attaches/changes
  $effect(() => {
    if (!textarea) return
    const cs = getComputedStyle(textarea)
    const lh = parseFloat(cs.lineHeight)
    if (!Number.isNaN(lh)) lineHeight = lh
    fontFamily = cs.fontFamily
    fontSize = cs.fontSize
    totalLines = textarea.value.split('\n').length

    const onScroll = () => { scrollTop = textarea!.scrollTop }
    const onInput = () => { totalLines = textarea!.value.split('\n').length }
    textarea.addEventListener('scroll', onScroll, { passive: true })
    textarea.addEventListener('input', onInput)

    // Force soft-wrap off so our gutter rows align with logical lines
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

  function copyId(id: string) {
    navigator.clipboard.writeText(id).catch(() => {})
  }

  function formatBadge(id: string, line: number): string {
    return badgeFormat === 'full' ? `${id} (line ${line})` : id
  }
</script>

<div class="block-gutter"
     style:font-family={fontFamily}
     style:font-size={fontSize}
     style:line-height="{lineHeight}px">
  <div class="block-gutter-inner" style:transform="translateY({-scrollTop}px)">
    {#each Array(totalLines) as _, i}
      {@const line = i + 1}
      {@const entry = lineMap.get(line)}
      <div class="block-gutter-row" style:height="{lineHeight}px">
        {#if entry?.isStart}
          <button class="block-gutter-label"
                  type="button"
                  title="Click to copy {entry.blockid}"
                  onclick={() => copyId(entry.blockid)}>
            {formatBadge(entry.blockid, line)}
          </button>
        {:else if entry}
          <span class="block-gutter-bar"></span>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .block-gutter {
    width: 84px;
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
    padding: 0 6px;
  }
  .block-gutter-label {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: color-mix(in srgb, currentColor 65%, transparent);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
    text-align: left;
  }
  .block-gutter-label:hover {
    color: currentColor;
  }
  .block-gutter-bar {
    display: inline-block;
    width: 2px;
    height: 100%;
    background: color-mix(in srgb, currentColor 25%, transparent);
    margin-left: 8px;
  }
</style>
