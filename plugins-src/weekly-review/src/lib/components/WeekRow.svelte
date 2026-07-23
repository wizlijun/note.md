<script lang="ts">
  import type { MonthWeek } from '../isoweek'
  import { t } from '../strings'

  interface Props {
    row: MonthWeek
    reviewPath: string | null
    isToday: boolean
    isFuture: boolean
    onOpen: (path: string) => void
  }
  let { row, reviewPath, isToday, isFuture, onOpen }: Props = $props()

  const DOW_WEEKEND = [false, false, false, false, false, true, true]
  const state = $derived(reviewPath ? 'review' : isFuture ? 'future' : 'past')
  const tip = $derived(
    `${row.weekYear}-W${String(row.week).padStart(2, '0')} · ` +
      (reviewPath ? t('tip.review') : isFuture ? t('tip.future') : t('tip.none')),
  )
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="wk {state}"
  id={isToday ? 'wr-today' : undefined}
  class:today={isToday}
  class:clickable={!!reviewPath}
  title={tip}
  role={reviewPath ? 'button' : undefined}
  tabindex={reviewPath ? 0 : undefined}
  onclick={() => reviewPath && onOpen(reviewPath)}
  onkeydown={(e) => reviewPath && (e.key === 'Enter' || e.key === ' ') && onOpen(reviewPath)}
>
  {#each row.days as d, i}
    <span class="day" class:we={DOW_WEEKEND[i]} class:empty={d === null}>{d ?? '·'}</span>
  {/each}
</div>

<style>
  .wk { display: grid; grid-template-columns: repeat(7, 1fr); border-radius: 7px; border: 1px solid transparent; }
  .wk.past { background: var(--past); }
  .wk.future { border-color: var(--future-line); }
  .wk.review { background: var(--accent); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.13); }
  .wk.clickable { cursor: pointer; }
  .wk.today { outline: 2.5px solid var(--today-ring); outline-offset: 1px; }
  .day { height: 22px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; }
  .wk.past .day { color: var(--past-day); }
  .wk.future .day { color: var(--future-day); }
  .day.we { color: var(--weekend); }
  .day.empty { color: transparent; }
  .wk.review .day { color: var(--accent-fg); }
  .wk.review .day.we { color: #ffe0dd; }
</style>
