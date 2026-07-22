<!-- Board.svelte — three-column kanban (candidates → open → archive), each column
     renders Card. Free-lane drag: candidate → open opens SignSheet; open →
     archive opens VerdictSheet; archive → open reopens (light confirm →
     doReopen); every other drag (candidate→archive, open→candidate, same-column
     cross-cell) snaps back with a one-line note (no write). Dragged card dims
     (opacity .5); the drop-target column highlights. Clicking a card is the
     equivalent accessible path (opens the matching modal). Each Open card also
     shows pending agent suggestion strips (closures + edit_decisions) beneath it.
     Candidate column footer "+ New Decision" opens SignSheet (manual create). -->
<script lang="ts">
  import { state as store, doReopen } from '../lib/store.svelte'
  import type { OpenDecision, Outcome } from '../lib/model'
  import type { NewCandidate, Closure } from '../lib/candidate'
  import Card from './Card.svelte'
  import SignSheet from './SignSheet.svelte'
  import VerdictSheet from './VerdictSheet.svelte'
  import ReviewPass from './ReviewPass.svelte'
  import SuggestionStrip, { type Suggestion } from './SuggestionStrip.svelte'
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
  // First closure per decision id (with its source file date), so open cards can
  // prefill their verdict + consume the closure on submit.
  const closureById = $derived.by(() => {
    const m = new Map<string, { closure: Closure; date: string }>()
    for (const f of store.candidates)
      for (const c of f.closures) if (!m.has(c.decision_id)) m.set(c.decision_id, { closure: c, date: f.fileDate })
    return m
  })
  // Pending agent suggestions grouped by decision id (closures + edit_decisions),
  // each tagged with its source file date (from filename) for later consume/dismiss.
  // Closures are deduplicated: only the first pending closure per decision_id is kept
  // (consistent with closureById; avoids cross-day duplicate strips becoming orphans).
  // edit_decisions are not deduplicated: different days may carry distinct progress notes.
  const suggestionsById = $derived.by(() => {
    const m = new Map<string, Suggestion[]>()
    const seenClosures = new Set<string>()
    const push = (id: string, s: Suggestion) => {
      const arr = m.get(id)
      if (arr) arr.push(s)
      else m.set(id, [s])
    }
    for (const f of store.candidates) {
      for (const c of f.closures) {
        if (seenClosures.has(c.decision_id)) continue
        seenClosures.add(c.decision_id)
        push(c.decision_id, { kind: 'closure', date: f.fileDate, closure: c })
      }
      for (const e of f.edit_decisions) push(e.decision_id, { kind: 'edit', date: f.fileDate, edit: e })
    }
    return m
  })

  // ── modal state ──
  let signCandidate = $state<NewCandidate | null | undefined>(undefined) // undefined = closed; null = manual
  let verdictDecision = $state<OpenDecision | null>(null)
  let verdictPreset = $state<Outcome | null>(null)
  let verdictConsumeDate = $state<string | null>(null)
  const signOpen = $derived(signCandidate !== undefined)

  // Open the verdict sheet for a decision, optionally prefilled from a suggestion.
  function openVerdictWith(decisionId: string, preset: Outcome | null, consumeDate: string | null) {
    const dec = store.open.find((x) => x.id === decisionId)
    if (!dec) return
    verdictPreset = preset
    verdictConsumeDate = consumeDate
    verdictDecision = dec
  }
  function closeVerdict() {
    verdictDecision = null
    verdictPreset = null
    verdictConsumeDate = null
  }

  // ── drag state ──
  // dragging/hoverCol are reactive so the board can dim the dragged card and
  // highlight the drop target (professional-kanban feel).
  let dragging = $state<{ column: Column; id: string } | null>(null)
  let hoverCol = $state<Column | null>(null)
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
  function endDrag() {
    dragging = null
    hoverCol = null
  }

  function dropOn(target: Column, e: DragEvent) {
    e.preventDefault()
    const d = dragging
    endDrag()
    if (!d) return
    // Free-lane drag: only the four legal transitions act; the rest snap back.
    if (d.column === 'candidates' && target === 'open') {
      openSignFor(d.id)
    } else if (d.column === 'open' && target === 'archive') {
      openVerdictWith(d.id, null, null)
    } else if (d.column === 'archive' && target === 'open') {
      confirmReopen(d.id)
    } else if (d.column !== target) {
      // candidate→archive, open→candidate, any same-column cross-cell = illegal.
      flashInvalid()
    }
  }

  async function confirmReopen(archivedId: string) {
    if (typeof confirm === 'function' && !confirm(t('drag.reopenConfirm'))) return
    await doReopen(archivedId)
  }

  function openSignFor(candidateId: string) {
    const c = candidates.find((x) => x.id === candidateId)
    if (c) signCandidate = c
  }

  // Prefill the verdict sheet from the decision's closure (evidence + outcome +
  // consume date), if any. Suggestion strips pass their own preset/date directly.
  const verdictClosureEntry = $derived(
    verdictDecision ? (closureById.get(verdictDecision.id) ?? null) : null
  )
  const verdictClosure = $derived(verdictClosureEntry?.closure ?? null)
  // If the sheet wasn't opened from a suggestion strip, fall back to the closure's date.
  const effectiveConsumeDate = $derived(verdictConsumeDate ?? verdictClosureEntry?.date ?? null)
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
    class:drop-target={hoverCol === 'candidates' && dragging && dragging.column !== 'candidates'}
    role="list"
    ondragover={(e) => { e.preventDefault(); hoverCol = 'candidates' }}
    ondragleave={() => { if (hoverCol === 'candidates') hoverCol = null }}
    ondrop={(e) => dropOn('candidates', e)}
  >
    <header class="col-head">{t('col.candidates')}</header>
    <div class="col-body">
      {#if candidates.length === 0}
        <p class="empty">{t('col.candidatesEmpty')}</p>
      {:else}
        {#each candidates as c (c.id)}
          <div class="card-slot" class:dragging={dragging?.column === 'candidates' && dragging?.id === c.id}>
            <Card
              column="candidates"
              candidate={c}
              onclick={() => (signCandidate = c)}
              ondragstart={(e) => startDrag('candidates', c.id, e)}
              ondragend={endDrag}
            />
          </div>
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
    class:drop-target={hoverCol === 'open' && dragging && dragging.column !== 'open'}
    role="list"
    ondragover={(e) => { e.preventDefault(); hoverCol = 'open' }}
    ondragleave={() => { if (hoverCol === 'open') hoverCol = null }}
    ondrop={(e) => dropOn('open', e)}
  >
    <header class="col-head">{t('col.open')}</header>
    <div class="col-body">
      {#if store.open.length === 0}
        <p class="empty">{t('col.openEmpty')}</p>
      {:else}
        {#each store.open as d (d.id)}
          <div class="card-slot" class:dragging={dragging?.column === 'open' && dragging?.id === d.id}>
            <Card
              column="open"
              decision={d}
              onclick={() => openVerdictWith(d.id, null, null)}
              ondragstart={(e) => startDrag('open', d.id, e)}
              ondragend={endDrag}
            />
            {#each suggestionsById.get(d.id) ?? [] as s, i (i)}
              <SuggestionStrip
                suggestion={s}
                onVerdict={(preset, date) => openVerdictWith(d.id, preset, date)}
              />
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  </section>

  <!-- Archive (drag back to Open to reopen) -->
  <section
    class="col archive-col"
    class:drop-target={hoverCol === 'archive' && dragging && dragging.column !== 'archive'}
    role="list"
    ondragover={(e) => { e.preventDefault(); hoverCol = 'archive' }}
    ondragleave={() => { if (hoverCol === 'archive') hoverCol = null }}
    ondrop={(e) => dropOn('archive', e)}
  >
    <header class="col-head">{t('col.archive')}</header>
    <div class="col-body">
      {#if store.archived.length === 0}
        <p class="empty">{t('col.archiveEmpty')}</p>
      {:else}
        {#each store.archived as a (a.id)}
          <div class="card-slot" class:dragging={dragging?.column === 'archive' && dragging?.id === a.id}>
            <Card
              column="archive"
              decision={a}
              ondragstart={(e) => startDrag('archive', a.id, e)}
              ondragend={endDrag}
            />
          </div>
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
    presetOutcome={verdictPreset}
    consumeDate={effectiveConsumeDate}
    onClose={closeVerdict}
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
  .col.drop-target {
    border-color: var(--accent, #2563eb);
    background: color-mix(in srgb, var(--accent, #2563eb) 6%, transparent);
  }
  .col-body {
    flex: 1;
    overflow-y: auto;
    padding: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .card-slot { display: flex; flex-direction: column; gap: 0.35rem; }
  .card-slot.dragging { opacity: 0.5; }
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
