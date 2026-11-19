<script lang="ts">
  import TabBar from './TabBar.svelte'
  import HomeDocumentHost from './HomeDocumentHost.svelte'
  import EditorPane from './EditorPane.svelte'
  import Toast from './Toast.svelte'
  import { tabs, activeTab } from '../lib/tabs.svelte'
  let current = $derived(activeTab())
</script>

<TabBar />
<Toast />
<HomeDocumentHost {current} {tabs} ready={true}>
  {#snippet children(document)}<EditorPane tab={document} />{/snippet}
</HomeDocumentHost>
