<script lang="ts">
  import HomeDocumentHost from './HomeDocumentHost.svelte'
  import CustomEditorIframe from './CustomEditorIframe.svelte'
  import { tabs, activeTab } from '../lib/tabs.svelte'
  let current = $derived(activeTab())
</script>
<HomeDocumentHost {current} {tabs} ready={true}>
  {#snippet children(tab)}<CustomEditorIframe {tab} />{/snippet}
</HomeDocumentHost>
