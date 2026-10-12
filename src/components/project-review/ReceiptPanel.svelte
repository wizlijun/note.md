<script lang="ts">
  import type { LocalFeedback } from '../../lib/project-share/types'
  let { feedback, disabled = false, onSave, onRetry }: {
    feedback: LocalFeedback; disabled?: boolean;
    onSave: (input: { enabled: boolean; reply: string }) => Promise<void>; onRetry: () => Promise<void>
  } = $props()
  let enabled = $state(true), reply = $state(''), busy = $state(false), error = $state('')
  let savedReceipt = ''
  $effect(() => {
    const serialized = JSON.stringify(feedback.receipt ?? null)
    if (serialized === savedReceipt) return
    savedReceipt = serialized; enabled = feedback.receipt?.state !== 'suppressed'; reply = feedback.receipt?.reply ?? ''
  })
  async function run(task: () => Promise<void>) {
    busy = true; error = ''
    try { await task() } catch { error = '回执设置保存失败，请重试' } finally { busy = false }
  }
</script>
<section aria-label="处理回执">
  <label><input type="checkbox" bind:checked={enabled} disabled={disabled || busy} />发送处理回执</label>
  <label>回复协作者<textarea bind:value={reply} maxlength="2000" disabled={disabled || busy}></textarea></label>
  <button disabled={disabled || busy || reply.length > 2000} onclick={() => { void run(() => onSave({ enabled, reply })) }}>保存回执设置</button>
  {#if feedback.receipt?.state === 'sent'}<p role="status">回执已发送</p>{:else if feedback.receipt?.state === 'suppressed'}<p role="status">回执已关闭</p>{:else}<p class="review-secondary">整份处理后发送回执</p>{/if}
  {#if error || feedback.receipt?.last_error}<p class="review-error" role="alert">{error || feedback.receipt?.last_error}</p><button disabled={disabled || busy} onclick={() => { void run(error ? () => onSave({ enabled, reply }) : onRetry) }}>重试回执</button>{/if}
</section>
