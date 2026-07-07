<!-- src/components/OpenClawDevicesTab.svelte -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { devicesState, refresh } from '../lib/openclaw/devices.svelte'
  import { revokeDevice, forgetDevice } from '../lib/openclaw/pair'
  import PairingDialog from './chat/PairingDialog.svelte'
  import { t } from '../lib/i18n/store.svelte'

  let showAdd = $state(false)

  onMount(() => { refresh() })

  function fmtLastSeen(ts: number | null): string {
    if (!ts) return t('time.never')
    const d = Date.now() - ts
    if (d < 60_000) return t('time.justNow')
    if (d < 3_600_000) return t('time.minutesAgo', { n: Math.floor(d / 60_000) })
    if (d < 86_400_000) return t('time.hoursAgo', { n: Math.floor(d / 3_600_000) })
    return t('time.daysAgo', { n: Math.floor(d / 86_400_000) })
  }

  function onAddClose() {
    showAdd = false
    refresh()
  }
</script>

<section>
  <h3>{t('openclaw.devices')}</h3>
  <table>
    <thead>
      <tr><th></th><th>{t('openclaw.hostname')}</th><th>{t('openclaw.lastSeen')}</th><th></th></tr>
    </thead>
    <tbody>
      {#each devicesState.list as d (d.device_id)}
        <tr>
          <td>{d.status === 'active' ? '●' : '○'}</td>
          <td>{d.hostname}</td>
          <td>{fmtLastSeen(d.last_seen)}</td>
          <td>
            {#if d.status === 'active'}
              <button onclick={async () => { await revokeDevice(d.device_id); await refresh() }}>{t('openclaw.revoke')}</button>
            {:else}
              <button onclick={async () => { await forgetDevice(d.device_id); await refresh() }}>{t('openclaw.forget')}</button>
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="4" class="empty">{t('openclaw.noPairedDevices')}</td></tr>
      {/each}
    </tbody>
  </table>

  <button class="primary" onclick={() => showAdd = true}>{t('openclaw.addDevice')}</button>
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
