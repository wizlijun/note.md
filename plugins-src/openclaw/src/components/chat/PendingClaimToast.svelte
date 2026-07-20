<!-- src/components/chat/PendingClaimToast.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { onPendingClaim, approveClaim, rejectClaim, type PendingClaim } from '../../lib/openclaw/pair'
  import { refresh } from '../../lib/openclaw/devices.svelte'

  let pending = $state<PendingClaim[]>([])

  onMount(() => {
    // v2 onPendingClaim returns the unsubscribe fn synchronously (v1 returned a
    // Promise from listen()).
    const unsub = onPendingClaim((c) => { pending = [...pending, c] })
    return () => { unsub() }
  })

  async function allow(c: PendingClaim) {
    await approveClaim(c.device_id, c.hostname)
    await refresh()
    pending = pending.filter((p) => p.device_id !== c.device_id)
  }
  async function reject(c: PendingClaim) {
    await rejectClaim(c.device_id)
    await refresh()
    pending = pending.filter((p) => p.device_id !== c.device_id)
  }
</script>

{#each pending as c (c.device_id)}
  <div class="toast">
    <div>New device wants to connect: <b>{c.hostname}</b></div>
    <div class="actions">
      <button onclick={() => allow(c)}>Allow</button>
      <button onclick={() => reject(c)}>Reject</button>
    </div>
  </div>
{/each}

<style>
  .toast { position: fixed; right: 1rem; top: 1rem; background: #fff; padding: 0.75rem 1rem; border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); z-index: 900; }
  .actions { margin-top: 0.5rem; display: flex; gap: 0.5rem; justify-content: flex-end; }
  button { padding: 0.25rem 0.75rem; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; }
</style>
