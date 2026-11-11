<script lang="ts">
  // Zero hits, then other wordings found something: a passive summary of the
  // rephrase. The results are local only and never judged; nothing here is
  // editable (plan behaviour 9).
  import { t } from '../../lib/i18n/store.svelte'
  import type { TermGroup } from '../../lib/smart-search/api'
  import { formatDuration, groupItems, wordingLetter } from './format'

  interface Props {
    /** The original lookup and the regrouped result. */
    summary: { originalHits: number; originalMs: number; resultHits: number }
    groups: TermGroup[]
    /** Hits per wording. */
    counts: number[] | null
    /** Set when the wordings came from the repair model. */
    source: { elapsedMs: number } | null
  }

  let { summary, groups, counts, source }: Props = $props()
</script>

<section class="repair-strip" aria-label={t('smartSearch.answer.tried')}>
  <span class="summary-flow">
    <span>{t('smartSearch.enhance.repairSummaryOriginal', { n: summary.originalHits, took: formatDuration(summary.originalMs) })}</span>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>
    <strong>{t(groups.length > 1 ? 'smartSearch.enhance.repairSummaryTwo' : 'smartSearch.enhance.repairSummaryOne', { n: summary.resultHits })}</strong>
  </span>
  {#each groups as group, index (index)}
    <div class="wording">
      <span class="glabel">{counts
        ? t('smartSearch.enhance.repairGroup', { n: wordingLetter(index), count: counts[index] ?? 0 })
        : t('smartSearch.enhance.wordingLabel', { n: wordingLetter(index) })}</span>
      {#each groupItems(group) as item, itemIndex (itemIndex)}<span class="term">{item}</span>{/each}
    </div>
  {/each}
  <span class="note">{#if source}{t('smartSearch.enhance.repairSource', { took: formatDuration(source.elapsedMs) })} · {/if}{t('smartSearch.enhance.repairNotJudged')}</span>
</section>

<style>
  .repair-strip { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 8px; background: var(--lookup-soft); font-size: 12px; }
  .summary-flow { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--lookup-muted); }
  .summary-flow strong { color: CanvasText; font-weight: 600; }
  .wording { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .glabel { min-width: 72px; font-weight: 600; color: var(--lookup-muted); }
  .term { padding: 0 6px; border: 1px solid var(--lookup-border); border-radius: 4px; background: Canvas; line-height: 18px; }
  .note { font-size: 11px; color: var(--lookup-muted); }
</style>
