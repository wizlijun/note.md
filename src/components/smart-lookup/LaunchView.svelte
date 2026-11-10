<script lang="ts">
  // Smart Lookup launch view: recent lookups (this device only) and the
  // first-run note. The window owns the state; this only renders it.
  import { t } from '../../lib/i18n/store.svelte'

  interface Props {
    showFirstRun: boolean
    /** The plain prompt when there is nothing else to show. */
    showEmpty: boolean
    recent: string[]
    counts: Record<string, number>
    /** Index chosen with ↑/↓ from the input; -1 = none. */
    selected: number
    onDismissFirstRun: () => void
    onRun: (question: string) => void
    onClear: () => void
  }

  let { showFirstRun, showEmpty, recent, counts, selected, onDismissFirstRun, onRun, onClear }: Props = $props()

  const steps = [
    ['smartSearch.enhance.firstRunStep1Lead', 'smartSearch.enhance.firstRunStep1'],
    ['smartSearch.enhance.firstRunStep2Lead', 'smartSearch.enhance.firstRunStep2'],
    ['smartSearch.enhance.firstRunStep3Lead', 'smartSearch.enhance.firstRunStep3'],
  ] as const
</script>

<div class="launch">
  {#if recent.length}
    <section class="recent" aria-label={t('smartSearch.enhance.recentTitle')}>
      <header class="recent-header">
        <h2>{t('smartSearch.enhance.recentTitle')}</h2>
        <button class="text-button" onclick={onClear}>{t('smartSearch.enhance.recentClear')}</button>
      </header>
      <ul>
        {#each recent as entry, index (entry)}
          <li>
            <button
              class="recent-item"
              class:selected={index === selected}
              aria-current={index === selected ? 'true' : undefined}
              onclick={() => onRun(entry)}
            >
              <svg class="clock" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
              <span class="recent-question">{entry}</span>
              {#if counts[entry] !== undefined}
                <span class="recent-count">{t('smartSearch.enhance.recentCount', { n: counts[entry] })}</span>
              {/if}
              <kbd class="recent-enter" aria-hidden="true">{index === selected ? '↵' : ''}</kbd>
            </button>
          </li>
        {/each}
      </ul>
      <p class="recent-note">{t('smartSearch.enhance.recentLocalOnly')}</p>
    </section>
  {:else if showEmpty}
    <div class="empty-launch">
      <h1>{t('smartSearch.emptyTitle')}</h1>
      <p>{t('smartSearch.emptyPrompt')}</p>
    </div>
  {/if}
  {#if showFirstRun}
    <aside class="first-run" aria-label={t('smartSearch.enhance.firstRunTitle')}>
      <div class="first-run-top">
        <span>{t('smartSearch.enhance.firstRunOnce')}</span>
        <button class="close" aria-label={t('smartSearch.enhance.firstRunClose')} onclick={onDismissFirstRun}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
        </button>
      </div>
      <strong class="first-run-title">{t('smartSearch.enhance.firstRunTitle')}</strong>
      <ol class="steps">
        {#each steps as [lead, rest], index (lead)}
          <li><span class="num" aria-hidden="true">{index + 1}</span><span><strong>{t(lead)}</strong>{t(rest)}</span></li>
        {/each}
      </ol>
      <p class="first-run-note">{t('smartSearch.enhance.firstRunFootnote')}</p>
      <button class="primary-button" onclick={onDismissFirstRun}>{t('smartSearch.enhance.firstRunDismiss')}</button>
    </aside>
  {/if}
</div>

<style>
  .launch { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 16px; padding: 12px 18px 18px; border-top: 1px solid var(--lookup-border); }
  .recent, .empty-launch { grid-column: 1; }
  .recent h2 { margin: 0; font-size: 12px; font-weight: 600; color: var(--lookup-muted); }
  .recent-header { display: flex; align-items: center; justify-content: space-between; }
  .recent ul { list-style: none; margin: 6px 0 0; padding: 0; }
  .recent-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; text-align: left; font: inherit; font-size: 13px; color: inherit; }
  .recent-item:hover, .recent-item:focus-visible, .recent-item.selected { background: color-mix(in srgb, var(--lookup-accent) 9%, Canvas); }
  .recent-item .clock { flex: 0 0 auto; color: var(--lookup-muted); }
  .recent-item.selected .clock { color: var(--lookup-accent); }
  .recent-question { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent-count { flex: 0 0 auto; font-size: 11px; color: var(--lookup-muted); }
  .recent-enter { flex: 0 0 14px; font: inherit; font-size: 11px; color: var(--lookup-muted); }
  .recent-note { margin: 8px 8px 0; font-size: 11px; color: var(--lookup-muted); }
  .text-button { padding: 2px 4px; border: 0; background: transparent; color: var(--lookup-accent); font: inherit; font-size: 12px; }
  .empty-launch { display: flex; flex-direction: column; align-items: center; padding: 48px 24px; text-align: center; }
  .empty-launch h1 { font-size: 19px; font-weight: 600; margin: 0 0 8px; }
  .empty-launch p { margin: 0; max-width: 380px; color: var(--lookup-muted); font-size: 13px; line-height: 1.6; }
  .first-run { grid-column: 2; width: 280px; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 1px solid var(--lookup-border); border-radius: 10px; background: var(--lookup-soft); font-size: 12px; }
  .first-run-top { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--lookup-muted); }
  .close { display: grid; place-items: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--lookup-muted); }
  .close:hover { background: var(--lookup-soft); }
  .first-run-title { font-size: 13px; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; line-height: 1.55; }
  .steps li { display: flex; gap: 8px; }
  .num { flex: 0 0 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--lookup-accent) 14%, transparent); color: var(--lookup-accent); font-size: 11px; font-weight: 600; }
  .first-run-note { margin: 0; color: var(--lookup-muted); font-size: 11px; }
  .primary-button { align-self: flex-end; padding: 5px 14px; border: 0; border-radius: 7px; background: var(--lookup-accent); color: #fff; font: inherit; font-size: 12px; }
  @media (max-width: 719.98px) {
    .launch { grid-template-columns: minmax(0, 1fr); }
    .first-run { grid-column: 1; grid-row: 1; width: auto; }
  }
</style>
