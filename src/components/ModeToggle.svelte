<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { toggleMode } from '../lib/tabs.svelte'

  let { tab }: { tab: Tab } = $props()
</script>

<button class="toggle" onclick={() => toggleMode(tab.id)} title="Toggle source / rich (Cmd+/)">
  {tab.mode === 'source' ? 'Source' : 'Rich'}
</button>

<style>
  .toggle {
    position: absolute;
    top: 6px;
    right: 12px;
    z-index: 10;
    padding: 4px 10px;
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas;
    color: CanvasText;
    font-size: 12px;
    cursor: pointer;
    opacity: 0.7;
  }
  .toggle:hover { opacity: 1; }
</style>
