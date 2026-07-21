<!-- VerdictSheet.svelte — one-screen, two-question verdict modal (open → archive).
     Q1 t('verdict.q1') → hit/partial/miss; Q2 t('verdict.q2') → yes/no
     (stillEndorse). Top shows read-only prediction (🔒) + any attached evidence.
     On submit calls doVerdict, resolved = today. Coach tone: a miss is NOT
     rendered as failure (spec §3 S5 / §7.4). -->
<script lang="ts">
  import type { OpenDecision, Outcome } from '../lib/model'
  import type { Closure } from '../lib/candidate'
  import { OUTCOMES } from '../lib/model'
  import { doVerdict } from '../lib/store.svelte'
  import { t } from '../lib/strings'

  let {
    decision,
    closure,
    onClose,
  }: {
    decision: OpenDecision
    closure?: Closure | null
    onClose: () => void
  } = $props()

  const today = new Date().toISOString().slice(0, 10)

  // svelte-ignore state_referenced_locally
  let outcome = $state<Outcome | null>(closure?.suggested_outcome ?? null)
  let stillEndorse = $state<boolean | null>(null)
  let submitting = $state(false)
  let error = $state('')

  const evidence = $derived(closure?.evidence ?? [])
  const canSubmit = $derived(!!outcome && stillEndorse !== null && !submitting)

  async function submit() {
    if (!outcome || stillEndorse === null || submitting) return
    submitting = true
    error = ''
    try {
      await doVerdict(decision.id, {
        outcome,
        stillEndorse,
        resolved: today,
        ...(evidence.length ? { evidence } : {}),
      })
      onClose()
    } catch (e) {
      error = String(e)
      submitting = false
    }
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onClose() }} />

<div class="overlay" onclick={onClose} role="presentation">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="sheet" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" tabindex="-1">
    <!-- read-only, locked context -->
    <div class="locked">
      <span class="lock" title={t('verdict.locked')}>🔒</span>
      <div>
        <div class="pred">{decision.prediction}</div>
        <div class="conf">{t(`sign.confidence.${decision.confidence}` as 'sign.confidence.low')}</div>
      </div>
    </div>

    <div class="evidence">
      <span class="lbl">{t('verdict.evidence')}</span>
      {#if evidence.length}
        <ul>
          {#each evidence as ev, i (i)}
            <li>“{ev.quote}”</li>
          {/each}
        </ul>
      {:else}
        <p class="muted">{t('verdict.noEvidence')}</p>
      {/if}
    </div>

    <!-- Q1 -->
    <div class="question">
      <p class="q">{t('verdict.q1')}</p>
      <div class="choices">
        {#each OUTCOMES as o (o)}
          <button
            type="button"
            class="choice"
            class:active={outcome === o}
            onclick={() => (outcome = o)}
          >
            {o === 'hit' ? '✅' : o === 'partial' ? '◐' : '·'}
            {t(`verdict.${o === 'miss' ? 'miss' : o}` as 'verdict.hit')}
          </button>
        {/each}
      </div>
    </div>

    <!-- Q2 -->
    <div class="question">
      <p class="q">{t('verdict.q2')}</p>
      <div class="choices">
        <button type="button" class="choice" class:active={stillEndorse === true} onclick={() => (stillEndorse = true)}>
          {t('verdict.endorseYes')}
        </button>
        <button type="button" class="choice" class:active={stillEndorse === false} onclick={() => (stillEndorse = false)}>
          {t('verdict.endorseNo')}
        </button>
      </div>
    </div>

    {#if error}<p class="err">{error}</p>{/if}

    <div class="actions">
      <button type="button" class="ghost" onclick={onClose}>{t('common.cancel')}</button>
      <button type="button" class="primary" disabled={!canSubmit} onclick={submit}>
        {t('verdict.submit')}
      </button>
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4);
    display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 50;
  }
  .sheet {
    background: var(--sheet-bg, Canvas); color: CanvasText;
    border-radius: 12px; padding: 1.25rem 1.5rem; width: min(480px, 100%);
    max-height: 90vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
  }
  .locked {
    display: flex; gap: 0.6rem; align-items: flex-start;
    padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem;
    background: color-mix(in srgb, currentColor 6%, transparent);
  }
  .lock { flex: 0 0 auto; }
  .pred { font-weight: 500; }
  .conf { font-size: 0.8rem; opacity: 0.65; margin-top: 0.2rem; }
  .evidence { margin-bottom: 1.1rem; }
  .lbl { display: block; font-size: 0.75rem; opacity: 0.6; margin-bottom: 0.3rem; }
  .evidence ul { margin: 0; padding-left: 1.1rem; font-size: 0.88rem; }
  .evidence li { margin: 0.15rem 0; }
  .muted { margin: 0; font-size: 0.85rem; opacity: 0.55; }
  .question { margin-bottom: 1.1rem; }
  .q { margin: 0 0 0.5rem; font-size: 0.95rem; }
  .choices { display: flex; gap: 0.5rem; }
  .choice {
    flex: 1; padding: 0.55rem; border: 1px solid var(--line, #d1d5db); border-radius: 6px;
    background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  .choice.active { background: var(--accent, #2563eb); color: #fff; border-color: var(--accent, #2563eb); }
  .err { color: #dc2626; font-size: 0.85rem; margin: 0 0 0.5rem; }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem; }
  button.primary { padding: 0.5rem 1rem; border: 0; border-radius: 6px; background: var(--accent, #2563eb); color: #fff; cursor: pointer; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.ghost { padding: 0.5rem 1rem; border: 1px solid var(--line, #d1d5db); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
</style>
