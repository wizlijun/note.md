<script lang="ts">
  import MonthGrid from './MonthGrid.svelte'
  import { t } from '../strings'

  interface Props {
    year: number
    weeks: Map<number, string> | undefined
    todayMondayMs: number
    onOpen: (path: string) => void
  }
  let { year, weeks, todayMondayMs, onOpen }: Props = $props()
  const months = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
</script>

<div class="cal">
  {#each months as m}
    <MonthGrid {year} month0={m} {weeks} {todayMondayMs} {onOpen} />
  {/each}
</div>

<div class="legend">
  <div class="it"><span class="sw review"></span>{t('legend.review')}</div>
  <div class="it"><span class="sw today"></span>{t('legend.today')}</div>
  <div class="it"><span class="sw past"></span>{t('legend.past')}</div>
  <div class="it"><span class="sw future"></span>{t('legend.future')}</div>
</div>

<style>
  .cal { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px 18px; padding: 8px 22px 16px; }
  .legend { display: flex; gap: 16px; margin: 2px 22px 16px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); flex-wrap: wrap; }
  .legend .it { display: flex; align-items: center; gap: 6px; }
  .sw { width: 22px; height: 15px; border-radius: 5px; }
  .sw.review { background: var(--accent); }
  .sw.today { background: var(--past); outline: 2.5px solid var(--today-ring); outline-offset: -2px; }
  .sw.past { background: var(--past); }
  .sw.future { background: transparent; border: 1px solid var(--future-line); }
</style>
