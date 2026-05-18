<!-- src/chat-app.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { start, stop } from './lib/openclaw/client.svelte'
  import SessionPicker from './components/chat/SessionPicker.svelte'
  import MessageList from './components/chat/MessageList.svelte'
  import Composer from './components/chat/Composer.svelte'
  import PendingClaimToast from './components/chat/PendingClaimToast.svelte'
  import RemoteOnboarding from './components/chat/RemoteOnboarding.svelte'

  let mode = $state<'detecting' | 'host' | 'remote' | 'needs-pairing'>('detecting')

  async function init() {
    try {
      const m = await start()
      mode = m === 'host' ? 'host' : 'remote'
    } catch (e) {
      if (String(e).includes('not paired')) mode = 'needs-pairing'
      else mode = 'remote'
    }
  }

  onMount(() => { init(); return () => stop() })
</script>

{#if mode === 'detecting'}
  <p>Detecting…</p>
{:else if mode === 'needs-pairing'}
  <RemoteOnboarding onComplete={() => init()} />
{:else}
  <main>
    <SessionPicker />
    <MessageList />
    <Composer />
  </main>
  <PendingClaimToast />
{/if}

<style>
  :global(body) { margin: 0; font-family: -apple-system, system-ui, sans-serif; }
  main { display: flex; flex-direction: column; height: 100vh; }
</style>
