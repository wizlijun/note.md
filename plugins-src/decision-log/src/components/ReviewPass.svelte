<!-- ReviewPass.svelte — the "due check" (weekly-review) focused overlay.
     Verdicts + strike counting ride inside this review pass, never as a
     standalone interruption (spec §4/§7/§S7/§S8). Overdue-and-undecided
     decisions are surfaced one at a time; each offers exactly two low-cognitive
     actions: give a verdict (opens VerdictSheet → doVerdict) or skip for now
     (doStrike → strikes+1; 3rd strike auto-downgrades & archives). Skipping is
     passive self-cleanup, never punishment: a downgrade shows a coach-tone line,
     not a red failure. Walking the queue closes the pass and refreshes. -->
<script lang="ts">
  import type { OpenDecision } from '../lib/model'
  import { doStrike, refresh } from '../lib/store.svelte'
  import VerdictSheet from './VerdictSheet.svelte'
  import Card from './Card.svelte'
  import { t } from '../lib/strings'

  let {
    queue,
    onClose,
  }: {
    // snapshot taken when the pass opens; we walk it by index so the board
    // mutating underneath us doesn't shift the queue.
    queue: OpenDecision[]
    onClose: () => Promise<void> | void
  } = $props()

  const today = new Date().toISOString().slice(0, 10)

  let index = $state(0)
  let showVerdict = $state(false)
  let downgradedNote = $state('') // coach-tone line shown after a skip triggers a downgrade
  let busy = $state(false)

  const current = $derived(queue[index] ?? null)

  async function advance() {
    downgradedNote = ''
    showVerdict = false
    if (index + 1 >= queue.length) {
      // queue done → close & refresh the board + scoreboard
      await refresh()
      await onClose()
      return
    }
    index += 1
  }

  async function onVerdictClosed() {
    // VerdictSheet only calls onClose after a successful doVerdict (or cancel);
    // either way we move on to the next card. On cancel the card stays overdue
    // and will resurface next due check.
    await advance()
  }

  async function skip() {
    if (!current || busy) return
    busy = true
    const wasThirdStrike = current.strikes >= 2 // this skip makes it strike 3 → downgrade
    try {
      await doStrike(current.id, today)
      if (wasThirdStrike) {
        // passive self-cleanup, coach tone — pause on the line before advancing
        downgradedNote = t('review.downgraded')
        busy = false
        return
      }
    } catch (e) {
      console.error('[decision-log] skip/strike failed:', e)
    }
    busy = false
    await advance()
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && !showVerdict) onClose() }} />

<div class="overlay" role="presentation">
  <div class="pass" role="dialog" aria-modal="true" tabindex="-1">
    <header class="pass-head">
      <span class="ttl">{t('review.title')}</span>
      <span class="progress">{index + 1} {t('review.of')} {queue.length}</span>
    </header>

    {#if current}
      <div class="focus">
        <Card column="open" decision={current} />
      </div>

      {#if downgradedNote}
        <p class="coach" role="status">{downgradedNote}</p>
        <div class="actions">
          <button type="button" class="primary" onclick={advance} aria-label="continue">→</button>
        </div>
      {:else}
        <div class="actions">
          <button type="button" class="ghost" disabled={busy} onclick={skip}>{t('review.skip')}</button>
          <button type="button" class="primary" disabled={busy} onclick={() => (showVerdict = true)}>{t('review.decide')}</button>
        </div>
      {/if}
    {/if}
  </div>
</div>

{#if showVerdict && current}
  <VerdictSheet decision={current} onClose={onVerdictClosed} />
{/if}

<style>
  .overlay {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
    display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 45;
  }
  .pass {
    background: var(--sheet-bg, Canvas); color: CanvasText;
    border-radius: 12px; padding: 1.25rem 1.5rem; width: min(460px, 100%);
    max-height: 90vh; overflow-y: auto; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
    display: flex; flex-direction: column; gap: 1rem;
  }
  .pass-head {
    display: flex; align-items: baseline; justify-content: space-between;
  }
  .ttl { font-size: 1rem; font-weight: 600; }
  .progress { font-size: 0.82rem; opacity: 0.6; }
  .focus { display: flex; flex-direction: column; }
  .coach {
    margin: 0; padding: 0.7rem 0.85rem; border-radius: 8px; font-size: 0.9rem; line-height: 1.5;
    background: color-mix(in srgb, currentColor 6%, transparent);
  }
  .actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
  button.primary { padding: 0.5rem 1rem; border: 0; border-radius: 6px; background: var(--accent, #2563eb); color: #fff; cursor: pointer; }
  button.primary:disabled { opacity: 0.5; cursor: not-allowed; }
  button.ghost { padding: 0.5rem 1rem; border: 1px solid var(--line, #d1d5db); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  button.ghost:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
