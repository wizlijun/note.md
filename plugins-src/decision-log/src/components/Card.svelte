<!-- Card.svelte — minimal card, ZERO action controls (spec §7.2).
     Variant per column: candidate = title + source badge (🎙quoted/💡nominated);
     open = title + confidence + days-to-check (⚡ if triggers); archive =
     title + outcome icon (✅hit/◐partial/❌miss/⊘dropped/⬇downgraded).
     The card emits `click` and a pointerdown (onDragStart) so the parent Board
     can run its own pointer-based lane drag (HTML5 DnD is swallowed by the Tauri
     window drag-drop handler); opening the action happens in the parent modal,
     not on the card. -->
<script lang="ts">
  import type { OpenDecision, ArchivedDecision } from '../lib/model'
  import type { NewCandidate } from '../lib/candidate'
  import { t } from '../lib/strings'

  type Column = 'candidates' | 'open' | 'archive'
  let {
    decision,
    candidate,
    column,
    onclick,
    onDragStart,
  }: {
    decision?: OpenDecision | ArchivedDecision
    candidate?: NewCandidate
    column: Column
    onclick?: () => void
    // pointerdown handler for the Board's pointer-based drag controller; the
    // Board decides (past a movement threshold) whether it becomes a drag.
    onDragStart?: (e: PointerEvent) => void
  } = $props()

  // Candidate and OpenDecision carry a title; ArchivedDecision does not
  // (spec §6.3 — archive front-matter has no title), so archive cards fall
  // back to the stable decision id.
  const title = $derived(
    candidate?.title ?? (column === 'open' ? (decision as OpenDecision | undefined)?.title : undefined) ?? ''
  )

  // ── days until check-date (open column) ──
  function daysUntil(dateISO: string): number {
    const today = new Date(new Date().toISOString().slice(0, 10)).getTime()
    const target = new Date(dateISO).getTime()
    return Math.round((target - today) / 86_400_000)
  }
  const openDec = $derived(column === 'open' ? (decision as OpenDecision | undefined) : undefined)
  const days = $derived(openDec ? daysUntil(openDec['check-date']) : 0)
  const dueLabel = $derived(
    days < 0 ? t('card.overdue') : days === 0 ? t('card.dueToday') : `${days} ${t('card.daysLeft')}`
  )
  const hasTriggers = $derived(!!openDec?.triggers?.length)

  // ── archive outcome icon ──
  const archDec = $derived(column === 'archive' ? (decision as ArchivedDecision | undefined) : undefined)
  const outcomeIcon = $derived(
    archDec?.status === 'closed'
      ? archDec.outcome === 'hit' ? '✅' : archDec.outcome === 'miss' ? '❌' : '◐'
      : archDec?.status === 'dropped' ? '⊘'
      : archDec?.status === 'downgraded' ? '⬇'
      : ''
  )

  function keyActivate(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onclick?.() }
  }
</script>

<div
  class="card"
  class:archive={column === 'archive'}
  role="button"
  tabindex="0"
  onclick={() => onclick?.()}
  onkeydown={keyActivate}
  onpointerdown={(e) => { if (e.button === 0) onDragStart?.(e) }}
>
  {#if column === 'candidates' && candidate}
    <div class="row">
      <span class="title">{title}</span>
      <span class="badge" title={candidate.prediction_source === 'quoted' ? t('badge.quoted') : t('badge.nominated')}>
        {candidate.prediction_source === 'quoted' ? '🎙' : '💡'}
      </span>
    </div>
  {:else if column === 'open' && openDec}
    <div class="title">{title}</div>
    <div class="meta">
      <span class="conf">{t(`sign.confidence.${openDec.confidence}` as 'sign.confidence.low')}</span>
      <span class="due" class:overdue={days < 0}>{dueLabel}</span>
      {#if hasTriggers}<span class="trig" title={t('sign.triggers')}>⚡</span>{/if}
    </div>
  {:else if column === 'archive' && archDec}
    <div class="row">
      <span class="title">{title || archDec.id}</span>
      <span class="icon">{outcomeIcon}</span>
    </div>
    {#if archDec.status === 'closed'}
      <div class="meta">
        <span class="endorse">{archDec['still-endorse'] ? '👍' : '🤔'} {t('card.stillEndorse')}</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .card {
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--line, #e5e7eb);
    border-radius: 8px;
    background: var(--card-bg, color-mix(in srgb, currentColor 3%, transparent));
    cursor: grab;
    font-size: 0.9rem;
    line-height: 1.35;
    user-select: none;
    touch-action: none;
  }
  .card:hover { border-color: var(--accent, #2563eb); }
  .card:focus-visible { outline: 2px solid var(--accent, #2563eb); outline-offset: 1px; }
  .card.archive { opacity: 0.85; }
  .row { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.4rem; }
  .title { font-weight: 500; }
  .badge, .icon { flex: 0 0 auto; }
  .meta { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.35rem; font-size: 0.78rem; opacity: 0.7; }
  .due.overdue { color: #dc2626; opacity: 1; }
  .trig { opacity: 1; }
  .endorse { opacity: 0.8; }
</style>
