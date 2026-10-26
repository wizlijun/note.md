<script lang="ts">
  import { taskHook, syncTaskHook, dismissTaskHook } from '../lib/task-hook.svelte'
  import { t } from '../lib/strings'
</script>

{#each Object.values(taskHook.jobs) as job (job.taskId)}
  <div class="hook-status" class:pending={job.status === 'pending'} role="status" aria-live="polite" data-hook-status={job.status}>
    <span>{t(`hook.status.${job.status}`, { title: job.title })}</span>
    {#if job.status === 'pending'}
      <button type="button" onclick={() => syncTaskHook(job.taskId, job.title)}>{t('hook.retry')}</button>
    {/if}
    {#if job.status !== 'running'}
      <button type="button" aria-label={t('hook.dismiss')} onclick={() => dismissTaskHook(job.taskId)}>×</button>
    {/if}
  </div>
{/each}

<style>
  .hook-status { display: flex; align-items: center; gap: 10px; margin: 8px 18px; padding: 9px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--card); color: var(--muted); font-size: 12px; }
  .hook-status span { flex: 1; }
  .pending { color: var(--fg); }
  button { flex: none; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--card); color: var(--fg); padding: 3px 8px; cursor: pointer; }
  button:hover { background: var(--hover); }
</style>
