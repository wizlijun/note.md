<!-- src/components/chat/Composer.svelte -->
<script lang="ts">
  import { sendUserMessage } from '../../lib/openclaw/client.svelte'
  import AttachmentUpload from './AttachmentUpload.svelte'

  let text = $state('')
  let sending = $state(false)

  async function submit(e: SubmitEvent) {
    e.preventDefault()
    if (!text.trim() || sending) return
    sending = true
    const payload = text
    text = ''
    try { await sendUserMessage(payload) } finally { sending = false }
  }
</script>

<form class="composer" onsubmit={submit}>
  <AttachmentUpload />
  <textarea
    bind:value={text}
    placeholder="Type to OpenClaw…"
    rows="2"
    onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(new SubmitEvent('submit')) }}
  ></textarea>
  <button type="submit" disabled={!text.trim() || sending}>Send</button>
</form>

<style>
  .composer { display: flex; align-items: flex-end; gap: 0.5rem; padding: 0.5rem; border-top: 1px solid #e5e7eb; }
  textarea { flex: 1; resize: none; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
  button { padding: 0 1rem; border: 0; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; }
  button:disabled { background: #9ca3af; cursor: not-allowed; }
</style>
