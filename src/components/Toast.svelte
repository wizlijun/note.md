<script lang="ts">
  import { toasts, dismissToast, type ToastItem } from '../lib/toast.svelte'

  let expanded = $state<Record<number, boolean>>({})

  function toggle(id: number) {
    expanded[id] = !expanded[id]
  }

  function levelClass(t: ToastItem) {
    return `toast toast-${t.level}`
  }
</script>

<div class="toast-stack" role="status" aria-live="polite">
  {#each toasts.list as t (t.id)}
    <div class={levelClass(t)}>
      <div class="row">
        <span class="msg">{t.message}</span>
        {#if t.detail}
          <button class="more" onclick={() => toggle(t.id)} aria-label="Show details">
            {expanded[t.id] ? '▴' : '▾'}
          </button>
        {/if}
        <button class="close" onclick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
      </div>
      {#if t.detail && expanded[t.id]}
        <pre class="detail">{t.detail}</pre>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toast-stack {
    position: fixed;
    right: 16px;
    bottom: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 9999;
    max-width: 420px;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    background: #1f1f1f;
    color: #f0f0f0;
    border-radius: 8px;
    padding: 10px 12px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    font-size: 13px;
    line-height: 1.4;
  }
  .toast-success { border-left: 3px solid #2ec27e; }
  .toast-info    { border-left: 3px solid #3584e4; }
  .toast-warn    { border-left: 3px solid #f5c211; }
  .toast-error   { border-left: 3px solid #e01b24; }
  .row { display: flex; align-items: center; gap: 8px; }
  .msg { flex: 1; word-break: break-word; }
  .more, .close {
    background: transparent; color: inherit; border: none;
    cursor: pointer; padding: 0 4px; font-size: 14px;
  }
  .detail {
    margin: 8px 0 0; padding: 6px 8px;
    background: rgba(0, 0, 0, 0.3); border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 11px; max-height: 160px; overflow: auto;
    white-space: pre-wrap; word-break: break-word;
  }
</style>
