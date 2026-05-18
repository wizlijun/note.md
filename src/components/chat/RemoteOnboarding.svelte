<!-- src/components/chat/RemoteOnboarding.svelte -->
<script lang="ts">
  import { pairClaim } from '../../lib/openclaw/pair'

  let { onComplete }: { onComplete: () => void } = $props()
  let code = $state('')
  let hostname = $state('')
  let busy = $state(false)
  let err: string | null = $state(null)

  async function submit() {
    busy = true; err = null
    // Trim guards against trailing whitespace from paste — common UX paper-cut.
    const trimmed = code.trim()
    try {
      await pairClaim(trimmed, hostname || undefined)
      onComplete()
    } catch (e) {
      err = String(e)
    } finally { busy = false }
  }
</script>

<section class="onboard">
  <h2>Connect to your OpenClaw</h2>
  <p>Enter the pairing code shown on your host machine's M↓ settings.</p>
  <label>Pairing code
    <input bind:value={code} placeholder="abc-def-012-345-678-9ab" />
  </label>
  <label>Device name (optional)
    <input bind:value={hostname} placeholder="my-laptop" />
  </label>
  {#if err}<p class="err">{err}</p>{/if}
  <button disabled={busy || code.length < 23} onclick={submit}>{busy ? 'Connecting…' : 'Pair'}</button>
</section>

<style>
  .onboard { max-width: 360px; margin: 4rem auto; padding: 1.5rem; border: 1px solid #e5e7eb; border-radius: 8px; }
  label { display: block; margin: 0.75rem 0; }
  input { width: 100%; padding: 0.4rem; }
  .err { color: #b91c1c; }
  button { width: 100%; padding: 0.5rem; background: #2563eb; color: white; border: 0; border-radius: 6px; cursor: pointer; }
  button:disabled { background: #9ca3af; }
</style>
