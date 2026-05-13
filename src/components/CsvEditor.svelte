<script lang="ts">
  import type { Tab } from '../lib/tabs.svelte'
  import { setContent } from '../lib/tabs.svelte'
  import MiniSpreadsheet from '../lib/spreadsheet/MiniSpreadsheet.svelte'

  let { tab }: { tab: Tab } = $props()

  function handleChange(csv: string) {
    setContent(tab.id, csv)
  }
</script>

<div class="csv-editor">
  {#key tab.id}
    <MiniSpreadsheet csvSource={tab.currentContent} onChange={handleChange} />
  {/key}
</div>

<style>
  .csv-editor {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
</style>
