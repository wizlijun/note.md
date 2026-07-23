<!-- src/components/daily/DailyOutlineView.svelte — read-only outline renderer for
     an inactive day. Renders an OutlineTree as static bullets; [[...]] wikilinks
     become clickable pills (emit `linkclick`). Clicking the text emits `activate`
     so the parent can turn this day into the live editor. Recurses via
     <svelte:self> for child nodes, forwarding both events upward. -->
<script lang="ts">
  import { childrenOf, type OutlineTree } from '../../lib/outline/model'
  import { t } from '../../lib/i18n/store.svelte'
  import { createEventDispatcher } from 'svelte'

  let { tree, parentId = null }: { tree: OutlineTree; parentId?: string | null } = $props()
  const dispatch = createEventDispatcher<{ linkclick: { raw: string }; activate: void }>()

  const nodes = $derived(childrenOf(tree, parentId))

  /** Split a node's content into plain-text and [[wikilink]] segments. */
  function segments(text: string): { t: 'text' | 'link'; v: string }[] {
    const out: { t: 'text' | 'link'; v: string }[] = []
    const re = /\[\[(.+?)\]\]/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) })
      out.push({ t: 'link', v: m[1] })
      last = re.lastIndex
    }
    if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
    return out
  }
</script>

<ul class="ol">
  {#each nodes as n (n.id)}
    <li>
      <span
        class="txt"
        role="button"
        tabindex="0"
        onclick={() => dispatch('activate')}
        onkeydown={(e) => { if (e.key === 'Enter') dispatch('activate') }}
      >
        {#each segments(n.content) as seg}{#if seg.t === 'link'}<button
              class="pill"
              onclick={(e) => { e.stopPropagation(); dispatch('linkclick', { raw: `[[${seg.v}]]` }) }}
            >{seg.v}</button>{:else}{seg.v}{/if}{/each}
      </span>
      <svelte:self {tree} parentId={n.id} on:linkclick on:activate />
    </li>
  {/each}
  {#if nodes.length === 0 && parentId === null}
    <li
      class="empty"
      role="button"
      tabindex="0"
      onclick={() => dispatch('activate')}
      onkeydown={(e) => { if (e.key === 'Enter') dispatch('activate') }}
    >{t('daily.emptyDay')}</li>
  {/if}
</ul>

<style>
  .ol { list-style: disc; margin: 0; padding-left: 1.2em; }
  li { margin: 2px 0; }
  .txt { cursor: text; }
  .pill {
    border: none;
    background: color-mix(in srgb, CanvasText 8%, transparent);
    border-radius: 4px;
    padding: 0 4px;
    cursor: pointer;
    font: inherit;
    color: LinkText;
  }
  .empty { color: color-mix(in srgb, CanvasText 40%, transparent); cursor: text; list-style: none; }
</style>
