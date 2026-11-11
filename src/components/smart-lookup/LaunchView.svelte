<script lang="ts">
  // Smart Lookup launch view: recent lookups (this device only), or the plain
  // prompt. The window owns the state; this only renders it.
  import { t } from '../../lib/i18n/store.svelte'

  interface Props {
    /** The plain prompt when there is nothing else to show. */
    showEmpty: boolean
    recent: string[]
    counts: Record<string, number>
    /** Index chosen with ↑/↓ from the input; -1 = none. */
    selected: number
    onRun: (question: string) => void
    onClear: () => void
  }

  let { showEmpty, recent, counts, selected, onRun, onClear }: Props = $props()
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
</div>

<style>
  .launch { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 18px 18px; border-top: 1px solid var(--lookup-border); }
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
</style>
