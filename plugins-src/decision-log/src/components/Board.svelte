<!-- Board.svelte — three-column kanban (candidates → open → archive), each column
     renders Card. Drag semantics (spec §7.3): candidate → open drop opens
     SignSheet; open → archive drop opens VerdictSheet; illegal drags snap back
     (no write) with a one-line note. Clicking a card is the equivalent
     accessible path (also opens the matching modal). Candidate column footer
     "+ New Decision" opens SignSheet (manual create). Archive column is
     read-only. -->
<script lang="ts">
  import { state as store } from '../lib/store.svelte'
  import type { OpenDecision } from '../lib/model'
  import type { NewCandidate, Closure } from '../lib/candidate'
  import Card from './Card.svelte'
  import SignSheet from './SignSheet.svelte'
  import VerdictSheet from './VerdictSheet.svelte'
  import ReviewPass from './ReviewPass.svelte'
  import { t } from '../lib/strings'

  type Column = 'candidates' | 'open' | 'archive'

  // ── due check (weekly review) ──
  // Overdue-and-undecided open decisions: check-date <= today. Verdicts + strike
  // counting ride inside this review pass, never as a standalone interruption.
  const today = new Date().toISOString().slice(0, 10)
  const overdue = $derived(store.open.filter((d) => d['check-date'] <= today))
  let reviewQueue = $state<OpenDecision[] | null>(null)
  function startReview() {
    // snapshot the queue at open time; ReviewPass walks it by index
    if (overdue.length) reviewQueue = [...overdue]
  }

  // Flattened candidate list across all daily files.
  const candidates = $derived(store.candidates.flatMap((f) => f.new_candidates))
  // All closures, keyed by decision id, so open cards can prefill their verdict.
  const closureById = $derived.by(() => {
    const m = new Map<string, Closure>()
    for (const f of store.candidates) for (const c of f.closures) m.set(c.decision_id, c)
    return m
  })

  // ── modal state ──
  let signCandidate = $state<NewCandidate | null | undefined>(undefined) // undefined = closed; null = manual
  let verdictDecision = $state<OpenDecision | null>(null)
  const signOpen = $derived(signCandidate !== undefined)

  // ── drag state (non-reactive is fine; only read on drop) ──
  let dragging: { column: Column; id: string } | null = null
  let invalidNote = $state('')
  let noteTimer: ReturnType<typeof setTimeout> | null = null

  function flashInvalid() {
    invalidNote = t('drag.invalid')
    if (noteTimer) clearTimeout(noteTimer)
    noteTimer = setTimeout(() => (invalidNote = ''), 2200)
  }

  function startDrag(column: Column, id: string, e: DragEvent) {
    dragging = { column, id }
    e.dataTransfer?.setData('text/plain', id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }

  function dropOn(target: Column, e: DragEvent) {
    e.preventDefault()
    const d = dragging
    dragging = null
    if (!d) return
    // legal: candidate → open, open → archive. everything else snaps back.
    if (d.column === 'candidates' && target === 'open') {
      openSignFor(d.id)
    } else if (d.column === 'open' && target === 'archive') {
      openVerdictFor(d.id)
    } else if (d.column !== target) {
      flashInvalid()
    }
  }

  function openSignFor(candidateId: string) {
    const c = candidates.find((x) => x.id === candidateId)
    if (c) signCandidate = c
  }
  function openVerdictFor(decisionId: string) {
    const dec = store.open.find((x) => x.id === decisionId)
    if (dec) verdictDecision = dec
  }

  const verdictClosure = $derived(
    verdictDecision ? (closureById.get(verdictDecision.id) ?? null) : null
  )
</script>

<div class="board-wrap">
  {#if overdue.length}
    <div class="toolbar">
      <button type="button" class="review-btn" onclick={startReview}>
        {t('review.start')}
        <span class="badge">{overdue.length}</span>
      </button>
    </div>
  {/if}

  <div class="board">
  <!-- Candidates -->
  <section
    class="col"
    role="list"
    ondragover={(e) => e.preventDefault()}
    ondrop={(e) => dropOn('candidates', e)}
  >
    <header class="col-head">{t('col.candidates')}</header>
    <div class="col-body">
      {#if candidates.length === 0}
        <p class="empty">{t('col.candidatesEmpty')}</p>
      {:else}
        {#each candidates as c (c.id)}
          <Card
            column="candidates"
            candidate={c}
            onclick={() => (signCandidate = c)}
            ondragstart={(e) => startDrag('candidates', c.id, e)}
          />
        {/each}
      {/if}
    </div>
    <button type="button" class="new-btn" onclick={() => (signCandidate = null)}>
      + {t('card.new')}
    </button>
  </section>

  <!-- Open -->
  <section
    class="col"
    role="list"
    ondragover={(e) => e.preventDefault()}
    ondrop={(e) => dropOn('open', e)}
  >
    <header class="col-head">{t('col.open')}</header>
    <div class="col-body">
      {#if store.open.length === 0}
        <p class="empty">{t('col.openEmpty')}</p>
      {:else}
        {#each store.open as d (d.id)}
          <Card
            column="open"
            decision={d}
            onclick={() => (verdictDecision = d)}
            ondragstart={(e) => startDrag('open', d.id, e)}
          />
        {/each}
      {/if}
    </div>
  </section>

  <!-- Archive (read-only) -->
  <section
    class="col archive-col"
    role="list"
    ondragover={(e) => e.preventDefault()}
    ondrop={(e) => dropOn('archive', e)}
  >
    <header class="col-head">{t('col.archive')}</header>
    <div class="col-body">
      {#if store.archived.length === 0}
        <p class="empty">{t('col.archiveEmpty')}</p>
      {:else}
        {#each store.archived as a (a.id)}
          <Card column="archive" decision={a} />
        {/each}
      {/if}
    </div>
  </section>
  </div>
</div>

{#if invalidNote}
  <div class="drag-note" role="status">{invalidNote}</div>
{/if}

{#if signOpen}
  <SignSheet candidate={signCandidate} onClose={() => (signCandidate = undefined)} />
{/if}
{#if verdictDecision}
  <VerdictSheet
    decision={verdictDecision}
    closure={verdictClosure}
    onClose={() => (verdictDecision = null)}
  />
{/if}
{#if reviewQueue}
  <ReviewPass queue={reviewQueue} onClose={() => { reviewQueue = null }} />
{/if}

<style>
  .board-wrap {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .toolbar {
    flex: 0 0 auto;
    display: flex;
    justify-content: flex-end;
    padding: 0.75rem 1rem 0;
  }
  .review-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.9rem;
    border: 1px solid var(--accent, #2563eb);
    border-radius: 999px;
    background: var(--accent, #2563eb);
    color: #fff;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .review-btn:hover { opacity: 0.9; }
  .review-btn .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.3rem;
    height: 1.3rem;
    padding: 0 0.35rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.25);
    font-size: 0.78rem;
    font-weight: 600;
  }
  .board {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
    padding: 1rem;
    min-height: 0;
    overflow: hidden;
  }
  .col {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border: 1px solid var(--line, #e5e7eb);
    border-radius: 10px;
    background: color-mix(in srgb, currentColor 2%, transparent);
  }
  .col-head {
    padding: 0.6rem 0.8rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.65;
    border-bottom: 1px solid var(--line, #e5e7eb);
  }
  .col-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .empty { margin: 0.5rem 0; font-size: 0.82rem; opacity: 0.5; line-height: 1.4; }
  .new-btn {
    margin: 0 0.6rem 0.6rem;
    padding: 0.5rem;
    border: 1px dashed var(--line, #d1d5db);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    opacity: 0.8;
  }
  .new-btn:hover { opacity: 1; border-color: var(--accent, #2563eb); }
  .archive-col { opacity: 0.95; }
  .drag-note {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    padding: 0.5rem 1rem;
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.8);
    color: #fff;
    font-size: 0.85rem;
    z-index: 40;
  }
</style>
