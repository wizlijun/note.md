<script lang="ts">
  import { parseInline } from '../../lib/outline/parser'
  let { content, onPageClick }: { content: string; onPageClick?: (target: string) => void } = $props()
  let segments = $derived(parseInline(content))
</script>

{#each segments as seg}
  {#if seg.t === 'text'}{seg.text}
  {:else if seg.t === 'page-link'}<button class="pl" onclick={() => onPageClick?.(seg.target)}>[[{seg.target}]]</button>
  {:else if seg.t === 'hashtag'}<button class="pl tag" onclick={() => onPageClick?.(seg.tag)}>#{seg.tag}</button>
  {:else if seg.t === 'block-ref'}<span class="block-ref" title={seg.refId}>(({seg.refId}))</span>
  {:else if seg.t === 'bold'}<strong>{seg.text}</strong>
  {:else if seg.t === 'italics'}<em>{seg.text}</em>
  {:else if seg.t === 'strikethrough'}<s>{seg.text}</s>
  {:else if seg.t === 'highlight'}<mark>{seg.text}</mark>
  {:else if seg.t === 'code'}<code>{seg.text}</code>
  {:else if seg.t === 'link'}<a href={seg.url} target="_blank" rel="noreferrer">{seg.text}</a>
  {:else if seg.t === 'image'}<img src={seg.url} alt={seg.alt} />
  {:else if seg.t === 'url'}<a href={seg.url} target="_blank" rel="noreferrer">{seg.url}</a>
  {/if}
{/each}

<style>
  .pl { background: none; border: none; padding: 0; color: var(--accent-color, #4a80d4); cursor: pointer; font: inherit; }
  .block-ref { border-bottom: 1px dashed currentColor; opacity: 0.8; }
  mark { background: var(--highlight-bg, #fde68a); border-radius: 2px; }
  img { max-width: 100%; }
</style>
