<script lang="ts">
  // Zero results after everything that ran: each attempt with its count and
  // time, how many model requests were made, and what to try next.
  import { t } from '../../lib/i18n/store.svelte'
  import type { TermGroup } from '../../lib/smart-search/api'
  import type { LookupAttempt } from '../../lib/smart-search/enhance-flow'
  import { formatAttempt, groupItems, wordingLetter } from './format'

  interface Props {
    /** In the order they ran; attempts that did not run come last. */
    attempts: LookupAttempt[]
    /** The wordings the 换说法 attempt searched with. */
    groups: TermGroup[]
    /** Diagnosis terms with no hits; the window passes none while the repair strip shows them. */
    struckTerms: string[]
    /** The time phrase when it only grouped results. */
    timeGrouped: string | null
    modelCalls: { total: number; judged: boolean }
    canExpand: boolean
    busy: boolean
    rewriteShortcut: string
    onRewrite: () => void
    onEditWording: () => void
    onExpand: () => void
  }

  let { attempts, groups, struckTerms, timeGrouped, modelCalls, canExpand, busy, rewriteShortcut, onRewrite, onEditWording, onExpand }: Props = $props()

  let allTried = $derived(attempts.length > 0 && attempts.every((attempt) => attempt.hits !== null))

  const LABEL = {
    original: 'smartSearch.enhance.attemptOriginal',
    rephrased: 'smartSearch.enhance.attemptRephrased',
    scan: 'smartSearch.enhance.attemptScan',
  } as const
</script>

<div class="no-match">
  <section class="tried" aria-label={t('smartSearch.enhance.noMatchTitle')}>
    <h2>{t('smartSearch.enhance.noMatchTitle')}</h2>
    <p class="lead">{t(allTried ? 'smartSearch.enhance.noMatchAllTried' : 'smartSearch.enhance.noMatchSomeTried')}</p>
    {#if struckTerms.length}
      <p class="struck">
        <span class="label">{t('smartSearch.enhance.diagnosisLabel')}</span>
        {#each struckTerms as term (term)}<s>{term}</s>{' '}{/each}
        <span>{t('smartSearch.enhance.diagnosisMissing')}</span>
      </p>
    {/if}
    <ul class="attempts">
      {#each attempts as attempt (attempt.kind)}
        <li class="attempt" class:not-run={attempt.hits === null}>
          <span class="icon" aria-hidden="true">{attempt.hits === null ? '–' : '✕'}</span>
          <div class="attempt-body">
            <div class="attempt-head">
              <strong>{t(LABEL[attempt.kind])}</strong>
              <span class="attempt-result">{attempt.hits === null
                ? t('smartSearch.enhance.attemptNotRun')
                : formatAttempt(attempt.hits, attempt.tookMs ?? 0)}</span>
            </div>
            {#if attempt.kind === 'original' && attempt.hits !== null}
              <span class="detail">{t('smartSearch.enhance.attemptOriginalDetail')}{#if timeGrouped}{t('smartSearch.enhance.attemptTimeGrouped', { range: timeGrouped })}{/if}</span>
            {/if}
            {#if attempt.kind === 'rephrased' && attempt.hits !== null}
              {#each groups as group, index (index)}
                <div class="group-line">
                  <span class="glabel">{t('smartSearch.enhance.wordingLabel', { n: wordingLetter(index) })}</span>
                  {#each groupItems(group) as item, itemIndex (itemIndex)}<span class="term">{item}</span>{/each}
                </div>
              {/each}
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </section>
  <section class="next" aria-label={t('smartSearch.enhance.nextSteps')}>
    <span class="label">{t('smartSearch.enhance.nextSteps')}</span>
    <div class="actions">
      <button class="primary-button" onclick={onRewrite}>{t('smartSearch.enhance.rewrite')} <kbd>{rewriteShortcut}</kbd></button>
      <button class="secondary-button" onclick={onEditWording}>{t('smartSearch.enhance.editWording')} <kbd>⇥</kbd></button>
      {#if canExpand}
        <button class="secondary-button" disabled={busy} onclick={onExpand}>{t('smartSearch.expandSearch')}</button>
      {/if}
    </div>
    <div class="calls">
      <strong>{t('smartSearch.enhance.modelCalls', { n: modelCalls.total })}</strong>
      <span>{t(modelCalls.judged ? 'smartSearch.enhance.modelCallsJudged'
        : modelCalls.total > 0 ? 'smartSearch.enhance.modelCallsRepair'
          : 'smartSearch.enhance.modelCallsNone')}</span>
    </div>
  </section>
</div>

<style>
  .no-match { display: flex; flex-direction: column; gap: 18px; padding: 20px 18px; font-size: 12px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .lead { margin: 4px 0 0; color: var(--lookup-muted); }
  .struck { margin: 8px 0 0; color: var(--lookup-muted); }
  .label { font-weight: 600; color: var(--lookup-muted); }
  s { color: CanvasText; }
  .attempts { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .attempt { display: flex; gap: 10px; }
  .icon { flex: 0 0 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; background: var(--lookup-soft); color: var(--lookup-muted); font-size: 10px; }
  .attempt-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .attempt-head { display: flex; justify-content: space-between; gap: 16px; }
  .attempt-result, .detail { color: var(--lookup-muted); }
  .not-run strong { color: var(--lookup-muted); font-weight: 500; }
  .group-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .glabel { min-width: 48px; color: var(--lookup-muted); }
  .term { padding: 0 6px; border: 1px solid var(--lookup-border); border-radius: 4px; background: var(--lookup-soft); line-height: 18px; }
  .next { display: flex; flex-direction: column; gap: 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .primary-button, .secondary-button { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 7px; font: inherit; font-size: 12px; }
  .primary-button { border: 0; background: var(--lookup-accent); color: #fff; }
  .secondary-button { border: 1px solid var(--lookup-border); background: var(--lookup-soft); color: inherit; }
  .secondary-button:disabled { opacity: .4; }
  kbd { font: inherit; font-size: 11px; opacity: .75; }
  .calls { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; background: var(--lookup-soft); color: var(--lookup-muted); }
  .calls strong { color: CanvasText; }
</style>
