<script lang="ts">
  import type { MonthWeek } from '../isoweek'
  import { t } from '../strings'
  import TimelineIcon from './TimelineIcon.svelte'

  interface Props {
    row: MonthWeek
    year: number
    month0: number
    reviewPath: string | null
    diaryIndex: Map<string, string>
    noteIndex: Map<string, string>
    timelineIndex: Map<string, string>
    isToday: boolean
    isFuture: boolean
    onOpen: (path: string) => void
  }
  let { row, year, month0, reviewPath, diaryIndex, noteIndex, timelineIndex, isToday, isFuture, onOpen }: Props = $props()

  const WE = [false, false, false, false, false, true, true]
  const state = $derived(reviewPath ? 'review' : isFuture ? 'future' : 'past')
  const pad = (n: number) => String(n).padStart(2, '0')
  const keyFor = (d: number) => `${year}-${pad(month0 + 1)}-${pad(d)}`

  function clickRow() {
    if (reviewPath) onOpen(reviewPath)
  }
  function openStop(e: Event, p: string) {
    e.stopPropagation()
    onOpen(p)
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="wk {state}"
  class:today={isToday}
  class:clickable={!!reviewPath}
  id={isToday ? 'wr-today' : undefined}
  title={reviewPath ? `${row.weekYear}-W${pad(row.week)}` : undefined}
  onclick={clickRow}
>
  {#each row.days as d, i}
    {#if d === null}
      <div class="day empty">·</div>
    {:else}
      {@const dk = keyFor(d)}
      {@const dp = diaryIndex.get(dk) ?? null}
      {@const np = noteIndex.get(dk) ?? null}
      {@const tp = timelineIndex.get(dk) ?? null}
      <div class="day" class:we={WE[i]} class:diary={!!dp}>
        {#if dp}
          <button class="num link" title={t('tip.diary')} onclick={(e) => openStop(e, dp)}>{d}</button>
        {:else}
          <span class="num">{d}</span>
        {/if}
        {#if np}
          <button class="day-icon note" title={t('tip.note')} aria-label={t('tip.note')} onclick={(e) => openStop(e, np)}>
            <svg class="star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5 C12.8 7.2 16.8 11.2 23.5 12 C16.8 12.8 12.8 16.8 12 23.5 C11.2 16.8 7.2 12.8 .5 12 C7.2 11.2 11.2 7.2 12 .5Z"/></svg>
          </button>
        {/if}
        {#if tp}
          <button class="day-icon timeline" title={t('tip.timeline')} aria-label={t('tip.timeline')} onclick={(e) => openStop(e, tp)}>
            <TimelineIcon />
          </button>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .wk { display: grid; grid-template-columns: repeat(7, 1fr); border-radius: 6px; border: 1px solid transparent; flex: 1 1 0; min-height: 22px; }
  .wk.past { background: var(--past); }
  .wk.future { border-color: var(--future-line); }
  .wk.review { background: var(--accent); }
  .wk.review.clickable { cursor: pointer; }
  .wk.today { outline: 2px solid var(--today-ring); outline-offset: 1px; }
  .day { position: relative; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; min-width: 0; }
  .wk.past .day { color: var(--past-day); }
  .wk.future .day { color: var(--future-day); }
  .day.we { color: var(--weekend); }
  .day.empty { color: transparent; }
  .wk.review .day { color: var(--accent-fg); }
  .num { font: inherit; color: inherit; }
  button.num, button.day-icon { background: none; border: none; padding: 0; margin: 0; cursor: pointer; line-height: 1; }
  .num.link { color: var(--link); text-decoration: underline; text-underline-offset: 2px; font-weight: 800; }
  .wk.review .num.link { color: #fff; text-decoration-color: #cfe0ff; }
  .day-icon { position: absolute; right: 0; display: block; width: 11px; height: 11px; color: var(--note); }
  .note { top: 0; }
  .timeline { bottom: 0; }
  .star { width: 100%; height: 100%; display: block; fill: currentColor; }
  .wk.review .day-icon { color: #ffe08a; }
</style>
