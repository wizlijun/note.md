<script lang="ts">
  import type { TimelineItem } from '../parser'
  import { formatDuration, formatTime } from '../layout'
  import { classifyItem, CATEGORIES, type ClassificationRule } from '../classification'

  let { item, rules, zh, onclose, onlink }: {
    item: TimelineItem
    rules: ClassificationRule[]
    zh: boolean
    onclose: () => void
    onlink: (target: string) => Promise<void>
  } = $props()
  const classification = $derived(classifyItem(item, rules))
  const category = $derived(CATEGORIES.find((entry) => entry.id === classification.category)!)
  const categoryNames: Record<string, string> = { work: 'Work', interest: 'Interests', life: 'Life', leisure: 'Leisure', other: 'Other' }
  let error = $state('')

  async function follow(target: string) {
    error = ''
    try { await onlink(target) }
    catch (cause) { error = `${zh ? '无法打开来源：' : 'Could not open source: '}${cause instanceof Error ? cause.message : String(cause)}` }
  }
</script>

{#snippet entry(value: TimelineItem, nested: boolean)}
  <div class:child={nested} class="entry">
    {#if nested}
      <div class="child-heading"><strong>{value.action || (zh ? '活动' : 'Activity')}</strong><span>{formatTime(value.start)}–{formatTime(value.end)}</span></div>
    {/if}
    <p class="entry-text">{value.text}</p>
    {#if value.links.length}
      <div class="sources" aria-label={zh ? '来源' : 'Sources'}>
        {#each value.links as link}
          <button class="source-link" title={link.target} onclick={() => follow(link.target)}><span aria-hidden="true">↗</span> {link.label || (zh ? '来源' : 'Source')}</button>
        {/each}
      </div>
    {/if}
    {#each value.children as child (child.id)}{@render entry(child, true)}{/each}
  </div>
{/snippet}

<svelte:window onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onclose() } }} />

<aside class="detail" aria-labelledby="detail-title">
  <div class="detail-top"><span class="category" data-category={category.id}>{zh ? category.label : categoryNames[category.id]}</span><button class="close" aria-label={zh ? '关闭详情' : 'Close details'} onclick={onclose}>×</button></div>
  <h2 id="detail-title">{classification.action || item.action || (zh ? '活动' : 'Activity')}</h2>
  {#if classification.action !== item.action && item.action}<p class="original-action">{item.action}</p>{/if}
  <div class="time-range">{formatTime(item.start)} <span>—</span> {formatTime(item.end)}<span class="duration">{formatDuration(item, zh)}</span></div>
  {@render entry(item, false)}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</aside>

<style>
  .detail { border-left: 1px solid var(--ui-separator); background: var(--ui-surface); padding: 20px; overflow-y: auto; min-width: 0; height: 100%; box-sizing: border-box; }
  .detail-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .category { border: 1px solid var(--category-border); background: var(--category-bg); color: CanvasText; border-radius: 5px; padding: 3px 8px; font-size: 11px; }
  .close { width: 28px; height: 28px; border: 0; background: transparent; border-radius: 6px; color: var(--ui-secondary); font-size: 21px; cursor: pointer; }
  .close:hover { background: var(--ui-hover); }
  h2 { font-size: 19px; line-height: 1.45; margin: 18px 0 8px; overflow-wrap: anywhere; }
  .original-action { margin: 0 0 10px; color: var(--ui-secondary); font-size: 12px; }
  .time-range { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12px; font-variant-numeric: tabular-nums; padding-bottom: 20px; border-bottom: 1px solid var(--ui-separator); }
  .time-range > span { color: var(--ui-tertiary); }
  .duration { margin-left: auto; }
  .entry-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.8; margin: 16px 0 10px; }
  .sources { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 6px; margin: 8px 0 16px; }
  .source-link { border: 1px solid var(--ui-separator); background: var(--ui-bg); color: var(--ui-accent-text); padding: 5px 8px; border-radius: 5px; text-align: left; font-size: 11px; max-width: 100%; overflow-wrap: anywhere; cursor: pointer; }
  .source-link:hover { background: var(--ui-selection); }
  .child { margin: 16px 0 0; padding-left: 12px; border-left: 2px solid var(--ui-separator); }
  .child-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 12px; }
  .child-heading span { color: var(--ui-tertiary); font-size: 10px; font-variant-numeric: tabular-nums; }
  .child .entry-text { margin-top: 6px; }
  .error { color: var(--ui-danger); overflow-wrap: anywhere; }
  @media (max-width: 780px) { .detail { border-left: 0; border-bottom: 1px solid var(--ui-separator); height: auto; max-height: 42vh; padding: 14px 20px; } h2 { margin-top: 8px; } }
</style>
