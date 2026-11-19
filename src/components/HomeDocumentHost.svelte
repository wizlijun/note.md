<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { Tab } from '../lib/tabs.svelte'

  let { current, tabs, ready, children }: { current: Tab | null; tabs: Tab[]; ready: boolean; children: Snippet<[Tab]> } = $props()
  let retained = $state<Tab | null>(null)
  $effect(() => {
    if (current) retained = current.kind === 'custom' ? current : null
    else if (retained && !tabs.includes(retained)) retained = null
  })
  let document = $derived(current ?? (retained && tabs.includes(retained) ? retained : null))
</script>

{#if document}
  <div class="document-column" hidden={!current} inert={!current} aria-busy={!ready}>
    {@render children(document)}
  </div>
{/if}

<style>
  .document-column { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
  .document-column[hidden] { display: none; }
</style>
