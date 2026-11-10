<script lang="ts">
  // The 换个说法 strip: what was tried, the local diagnosis, and the two
  // editable wordings. Editing searches locally only; the window runs it.
  import { t } from '../../lib/i18n/store.svelte'
  import { formatDuration, wordingLetter } from './format'

  interface Props {
    /** Diagnosis terms with no hits; shown struck through. */
    struckTerms: string[]
    inputs: string[]
    /** Hits per wording after a search; `null` before one. */
    counts: number[] | null
    error: string
    busy: boolean
    /** The original lookup and the regrouped result, once a regrouped search ran. */
    summary: { originalHits: number; originalMs: number; resultHits: number; groups: number } | null
    /** Set when the wordings came from the repair model. */
    source: { elapsedMs: number } | null
    canUseOriginal: boolean
    onInput: (index: number, value: string) => void
    onSearch: () => void
    onUseOriginal: () => void
  }

  let { struckTerms, inputs, counts, error, busy, summary, source, canUseOriginal, onInput, onSearch, onUseOriginal }: Props = $props()

  let fields: HTMLInputElement[] = $state([])

  /** Focus the first wording (⇥ from the question). */
  export function focusFirst(): void {
    fields[0]?.focus()
  }
</script>

<form class="repair-strip" aria-label={t('smartSearch.enhance.rephrase')} onsubmit={(event) => { event.preventDefault(); onSearch() }}>
  {#if summary || canUseOriginal}
    <div class="summary">
      {#if summary}
        <span class="summary-flow">
          <span>{t('smartSearch.enhance.repairSummaryOriginal', { n: summary.originalHits, took: formatDuration(summary.originalMs) })}</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>
          <strong>{t(summary.groups > 1 ? 'smartSearch.enhance.repairSummaryTwo' : 'smartSearch.enhance.repairSummaryOne', { n: summary.resultHits })}</strong>
        </span>
      {/if}
      <span class="spacer"></span>
      {#if source}
        <span class="source">{t('smartSearch.enhance.repairSource', { took: formatDuration(source.elapsedMs) })}</span>
      {/if}
      {#if canUseOriginal}
        <button type="button" class="secondary-button use-original" onclick={onUseOriginal}>{t('smartSearch.enhance.useOriginal')}</button>
      {/if}
    </div>
  {/if}
  {#if struckTerms.length}
    <div class="diagnosis">
      <span class="label">{t('smartSearch.enhance.diagnosisLabel')}</span>
      {#each struckTerms as term (term)}<s>{term}</s>{/each}
      <span>{t('smartSearch.enhance.diagnosisMissing')}</span>
      <span class="spacer"></span>
      <span class="no-model">{t('smartSearch.enhance.diagnosisNoModel')}</span>
    </div>
  {/if}
  {#each inputs as value, index (index)}
    <label class="wording">
      <span class="glabel">{t('smartSearch.enhance.wordingLabel', { n: wordingLetter(index) })}</span>
      <input bind:this={fields[index]} {value} oninput={(event) => onInput(index, (event.currentTarget as HTMLInputElement).value)} />
      <span class="count">{counts ? t('smartSearch.enhance.repairGroup', { n: wordingLetter(index), count: counts[index] ?? 0 }) : ''}</span>
    </label>
  {/each}
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  <div class="actions">
    <button class="secondary-button" type="submit" disabled={busy}>{t('smartSearch.enhance.repairSearch')}</button>
    <span class="hint">{t('smartSearch.enhance.repairHint')} {t('smartSearch.enhance.repairNotJudged')}</span>
  </div>
</form>

<style>
  .repair-strip { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; padding: 8px 16px 10px; border-bottom: 1px solid var(--lookup-border); font-size: 12px; }
  .summary, .diagnosis, .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .summary-flow { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--lookup-muted); }
  .summary-flow strong { color: CanvasText; font-weight: 600; }
  .spacer { flex: 1; }
  .source, .no-model, .hint, .label, .count { color: var(--lookup-muted); font-size: 11px; }
  .diagnosis { color: var(--lookup-muted); }
  .diagnosis .label { font-weight: 600; }
  s { color: CanvasText; }
  .wording { display: grid; grid-template-columns: 56px minmax(0, 1fr) max-content; align-items: center; gap: 8px; }
  .glabel { font-weight: 600; color: var(--lookup-muted); }
  .wording input { min-width: 0; padding: 4px 8px; border: 1px solid var(--lookup-border); border-radius: 6px; background: Canvas; color: CanvasText; font: inherit; }
  .secondary-button { padding: 4px 12px; border: 1px solid var(--lookup-border); border-radius: 7px; background: var(--lookup-soft); font: inherit; color: inherit; }
  .secondary-button:disabled { opacity: .4; }
  .notice { margin: 0; padding: 6px 10px; border-radius: 8px; font-size: 12px; }
  .notice.error { background: color-mix(in srgb, #ce3030 8%, Canvas); }
</style>
