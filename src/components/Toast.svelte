<script lang="ts">
  import { toasts, dismissToast, scheduleAutoDismiss, type ToastItem } from '../lib/toast.svelte'

  let expanded = $state<Record<number, boolean>>({})
  let autoClose = $state<Record<number, boolean>>({})

  const AUTO_DISMISS_MS = 4000

  function toggle(id: number) {
    expanded[id] = !expanded[id]
  }

  function toggleAutoClose(id: number) {
    autoClose[id] = !autoClose[id]
    if (autoClose[id]) {
      scheduleAutoDismiss(id, AUTO_DISMISS_MS)
    } else {
      scheduleAutoDismiss(id, 0)
    }
  }

  function levelIcon(t: ToastItem) {
    switch (t.level) {
      case 'success': return '✓'
      case 'error': return '✕'
      case 'warn': return '⚠'
      default: return '🔔'
    }
  }
</script>

{#if toasts.list.length > 0}
  <div class="toast-bar" role="status" aria-live="polite">
    {#each toasts.list as t (t.id)}
      <div class="toast toast-{t.level}">
        <div class="row">
          <span class="icon">{levelIcon(t)}</span>
          <span class="msg">{t.message}</span>
          {#if t.detail}
            <button class="more" onclick={() => toggle(t.id)} aria-label="Show details">
              {expanded[t.id] ? '收起' : '详情'}
            </button>
          {/if}
          <label class="auto-close">
            <input type="checkbox" checked={autoClose[t.id] ?? false} onchange={() => toggleAutoClose(t.id)} />
            自动关闭
          </label>
          <button class="close" onclick={() => dismissToast(t.id)} aria-label="Dismiss">×</button>
        </div>
        {#if t.detail && expanded[t.id]}
          <pre class="detail">{t.detail}</pre>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-bar {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    z-index: 100;
  }
  .toast {
    background: color-mix(in srgb, Canvas 85%, CanvasText 15%);
    color: CanvasText;
    padding: 10px 16px;
    font-size: 13px;
    line-height: 1.4;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
  }
  .toast-success .icon { color: #2ec27e; }
  .toast-info .icon    { color: #3584e4; }
  .toast-warn .icon    { color: #f5c211; }
  .toast-error .icon   { color: #e01b24; }
  .row { display: flex; align-items: center; gap: 10px; }
  .icon { font-size: 15px; flex-shrink: 0; }
  .msg { flex: 1; word-break: break-word; }
  .close {
    background: transparent; color: inherit; border: none;
    cursor: pointer; padding: 2px 6px; font-size: 16px;
    opacity: 0.7;
  }
  .close:hover { opacity: 1; }
  .more {
    background: transparent; color: inherit; border: none;
    cursor: pointer; padding: 4px 8px; font-size: 12px;
    opacity: 0.7;
  }
  .more:hover { opacity: 1; }
  .auto-close {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    opacity: 0.7;
    cursor: pointer;
    user-select: none;
  }
  .auto-close input {
    margin: 0;
    cursor: pointer;
  }
  .detail {
    margin: 8px 0 0 25px; padding: 6px 8px;
    background: color-mix(in srgb, Canvas 70%, CanvasText 30%);
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 11px; max-height: 160px; overflow: auto;
    white-space: pre-wrap; word-break: break-word;
  }
</style>
