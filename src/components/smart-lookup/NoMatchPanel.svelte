<script lang="ts">
  // No answer (NoAnswer board): nothing in the notes answers the question.
  // A passive list of the automatic tries that actually ran, each with its
  // count. No buttons: Return with other words is the next step.
  import { t } from '../../lib/i18n/store.svelte'
  import type { TriedStep } from '../../lib/smart-search/answer-view'

  interface Props {
    /** The tries that ran, in the order they ran. */
    steps: TriedStep[]
    /** A rephrase that produced no wording, as one line; empty when none. */
    notice: string
    /**
     * Passages of confidential notes the host left out unchecked over the run
     * (final review I4): a confidential note may hold the answer, so the list
     * says they were not checked.
     */
    confidential: number
  }

  let { steps, notice, confidential }: Props = $props()
</script>

<div class="no-match">
  <section class="answer" aria-label={t('smartSearch.answer.label')}>
    <span class="list-label">{t('smartSearch.answer.label')}</span>
    <p class="lead">{t('smartSearch.answer.noAnswer')}</p>
    <p class="hint">{t('smartSearch.answer.noAnswerHint')}</p>
  </section>
  {#if steps.length || notice || confidential > 0}
    <section class="tried" aria-label={t('smartSearch.answer.tried')}>
      <span class="list-label">{t('smartSearch.answer.tried')}</span>
      <ul>
        {#each steps as step (step.kind)}
          <li class="attempt"><span class="attempt-label">{t(step.label.key, step.label.params)}</span><span class="n">{t(step.result.key, step.result.params)}</span></li>
        {/each}
      </ul>
      {#if confidential > 0}<p class="notice confidential">{t('smartSearch.answer.skippedConfidential', { n: confidential })}</p>{/if}
      {#if notice}<p class="notice">{notice}</p>{/if}
    </section>
  {/if}
</div>

<style>
  .no-match { display: flex; flex-direction: column; gap: 14px; }
  .answer { display: flex; flex-direction: column; gap: 4px; }
  .lead { margin: 0; font-size: 15px; line-height: 1.6; }
  .hint { margin: 0; font-size: 12.5px; color: var(--lookup-muted); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .attempt { display: flex; justify-content: space-between; gap: 16px; font-size: 12.5px; }
  .attempt-label { min-width: 0; }
  .n { flex: none; color: var(--lookup-muted); }
  .notice { margin: 6px 0 0; font-size: 12px; color: var(--lookup-muted); }
</style>
