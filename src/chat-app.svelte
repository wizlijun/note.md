<!-- src/chat-app.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { start, stop } from './lib/openclaw/client.svelte'
  import SessionPicker from './components/chat/SessionPicker.svelte'
  import MessageList from './components/chat/MessageList.svelte'
  import Composer from './components/chat/Composer.svelte'
  import PendingClaimToast from './components/chat/PendingClaimToast.svelte'

  onMount(() => {
    start()
    return () => { stop() }
  })
</script>

<main>
  <SessionPicker />
  <MessageList />
  <Composer />
</main>
<PendingClaimToast />

<style>
  :global(body) { margin: 0; font-family: -apple-system, system-ui, sans-serif; }
  main { display: flex; flex-direction: column; height: 100vh; }
</style>
