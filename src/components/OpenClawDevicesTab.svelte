<!-- src/components/OpenClawDevicesTab.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { devicesState, refresh } from '../lib/openclaw/devices.svelte'
  import { revokeDevice, forgetDevice } from '../lib/openclaw/pair'
  import PairingDialog from './chat/PairingDialog.svelte'

  let showAdd = $state(false)

  onMount(() => { refresh() })

  function fmtLastSeen(ts: number | null): string {
    if (!ts) return 'never'
    const d = Date.now() - ts
    if (d < 60_000) return 'just now'
    if (d < 3_600_000) return Math.floor(d / 60_000) + 'm ago'
    if (d < 86_400_000) return Math.floor(d / 3_600_000) + 'h ago'
    return Math.floor(d / 86_400_000) + 'd ago'
  }

  function onAddClose() {
    showAdd = false
    refresh()
  }
</script>

<section>
  <h3>Devices</h3>
  <table>
    <thead>
      <tr><th></th><th>Hostname</th><th>Last seen</th><th></th></tr>
    </thead>
    <tbody>
      {#each devicesState.list as d (d.device_id)}
        <tr>
          <td>{d.status === 'active' ? '●' : '○'}</td>
          <td>{d.hostname}</td>
          <td>{fmtLastSeen(d.last_seen)}</td>
          <td>
            {#if d.status === 'active'}
              <button onclick={async () => { await revokeDevice(d.device_id); await refresh() }}>Revoke</button>
            {:else}
              <button onclick={async () => { await forgetDevice(d.device_id); await refresh() }}>Forget</button>
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="4" class="empty">No paired devices yet.</td></tr>
      {/each}
    </tbody>
  </table>

  <button class="primary" onclick={() => showAdd = true}>+ Add device</button>
</section>

{#if showAdd}
  <PairingDialog onClose={onAddClose} />
{/if}

<style>
  section { padding: 1rem; max-width: 560px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 0.5rem; border-bottom: 1px solid #eee; text-align: left; }
  .empty { color: #777; text-align: center; padding: 1rem; }
  button { padding: 0.25rem 0.75rem; border: 1px solid #d1d5db; background: white; border-radius: 4px; cursor: pointer; }
  .primary { background: #2563eb; color: white; border: 0; padding: 0.4rem 1rem; margin-top: 1rem; }
</style>
