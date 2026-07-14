<script lang="ts">
  import { parseInline, type Inline } from '../../lib/outline/parser'
  import { wikilinkBlocklistState } from '../../lib/wikilink/blocklist-io.svelte'
  let { content, onPageClick }: { content: string; onPageClick?: (target: string) => void } = $props()
  let segments = $derived.by(() => { void wikilinkBlocklistState.version; return parseInline(content) })
</script>

{#snippet render(seg: Inline)}
  {#if seg.t === 'text'}{seg.text}
  {:else if seg.t === 'page-link'}<button class="pl" onclick={() => onPageClick?.(seg.target)}>[[{seg.target}]]</button>
  {:else if seg.t === 'hashtag'}<button class="pl tag" onclick={() => onPageClick?.(seg.tag)}>#{seg.tag}</button>
  {:else if seg.t === 'block-ref'}<span class="block-ref" title={seg.refId}>(({seg.refId}))</span>
  {:else if seg.t === 'bold'}<strong>{#each seg.children as c}{@render render(c)}{/each}</strong>
  {:else if seg.t === 'italics'}<em>{#each seg.children as c}{@render render(c)}{/each}</em>
  {:else if seg.t === 'strikethrough'}<s>{#each seg.children as c}{@render render(c)}{/each}</s>
  {:else if seg.t === 'highlight'}<mark>{#each seg.children as c}{@render render(c)}{/each}</mark>
  {:else if seg.t === 'code'}<code>{#if seg.children}{#each seg.children as c}{@render render(c)}{/each}{:else}{seg.text}{/if}</code>
  {:else if seg.t === 'link'}<a href={seg.url} target="_blank" rel="noreferrer">{seg.text}</a>
  {:else if seg.t === 'image'}<img src={seg.url} alt={seg.alt} />
  {:else if seg.t === 'url'}<a href={seg.url} target="_blank" rel="noreferrer">{seg.url}</a>
  {/if}
{/snippet}

{#each segments as seg}{@render render(seg)}{/each}

<style>
  .pl { background: none; border: none; padding: 0; color: var(--accent-color, #4a80d4); cursor: pointer; font: inherit; }
  .pl:hover { text-decoration: underline; }
  .block-ref { border-bottom: 1px dashed currentColor; opacity: 0.8; }
  mark { background: var(--highlight-bg, #fde68a); border-radius: 2px; }
  img { max-width: 100%; }
</style>
