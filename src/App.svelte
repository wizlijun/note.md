<script lang="ts">
  import './styles/app.css'
  import { onMount } from 'svelte'
  import TabBar from './components/TabBar.svelte'
  import EditorPane from './components/EditorPane.svelte'
  import EmptyState from './components/EmptyState.svelte'
  import ModeToggle from './components/ModeToggle.svelte'
  import { activeTab } from './lib/tabs.svelte'
  import { loadSettings } from './lib/settings.svelte'

  onMount(async () => {
    try { await loadSettings() } catch (e) { console.warn('[App] loadSettings:', e) }
  })

  let current = $derived(activeTab())
</script>

<main>
  <TabBar />
  <section class="pane">
    {#if current}
      <ModeToggle tab={current} />
      <EditorPane tab={current} />
    {:else}
      <EmptyState />
    {/if}
  </section>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .pane {
    position: relative;
    flex: 1;
    display: flex;
    overflow: hidden;
  }
  .pane :global(.empty),
  .pane :global(textarea.source),
  .pane :global(.rich) {
    flex: 1;
  }
</style>
