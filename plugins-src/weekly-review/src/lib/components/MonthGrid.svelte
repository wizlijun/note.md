<script lang="ts">
  import { buildMonthRows } from '../isoweek'
  import WeekRow from './WeekRow.svelte'

  interface Props {
    year: number
    month0: number
    weeks: Map<number, string> | undefined
    todayMondayMs: number
    onOpen: (path: string) => void
  }
  let { year, month0, weeks, todayMondayMs, onOpen }: Props = $props()

  const DOW = ['一', '二', '三', '四', '五', '六', '日']
  const rows = $derived(buildMonthRows(year, month0))
</script>

<div class="month">
  <div class="wm">{month0 + 1}</div>
  <div class="mtitle">{month0 + 1}月</div>
  <div class="dow">
    {#each DOW as d, i}<span class:we={i >= 5}>{d}</span>{/each}
  </div>
  <div class="weeks">
    {#each rows as row}
      <WeekRow
        {row}
        reviewPath={weeks?.get(row.week) ?? null}
        isToday={row.monday.getTime() === todayMondayMs}
        isFuture={row.monday.getTime() > todayMondayMs}
        {onOpen}
      />
    {/each}
  </div>
</div>

<style>
  .month { position: relative; }
  .wm { position: absolute; right: 2px; top: 12px; font-size: 52px; font-weight: 800; color: var(--wm); z-index: 0; pointer-events: none; letter-spacing: -2px; }
  .mtitle { font-weight: 700; font-size: 13px; margin: 0 0 4px 2px; position: relative; z-index: 1; }
  .dow { display: grid; grid-template-columns: repeat(7, 1fr); position: relative; z-index: 1; }
  .dow span { text-align: center; font-size: 10px; color: var(--muted); font-weight: 600; padding-bottom: 2px; }
  .dow span.we { color: var(--weekend); }
  .weeks { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 2px; }
</style>
