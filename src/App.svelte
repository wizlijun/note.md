<script lang="ts">
  import './styles/app.css'
  import EditorPane from './components/EditorPane.svelte'
  import { activeTab, openFile } from './lib/tabs.svelte'
  import { onMount } from 'svelte'

  onMount(async () => {
    try {
      await openFile('/Users/bruce/git/moraya/README.md')
    } catch (e) {
      console.warn(e)
    }
  })

  let current = $derived(activeTab())
</script>

<main>
  {#if current}
    <EditorPane tab={current} />
  {:else}
    <p style="padding:16px">No file open</p>
  {/if}
</main>

<style>
  main {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
</style>
