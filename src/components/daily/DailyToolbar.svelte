<!-- src/components/daily/DailyToolbar.svelte — thin horizontal bar for the Daily
     Notes window: back/forward nav, refresh, a date picker (jump), and a debounced
     search box (filter). Pure presentation; all behavior is delegated to the
     callback props the root passes in. Theme-aware via Canvas/CanvasText. -->
<script lang="ts">
  import { onDestroy } from 'svelte'
  import { t } from '../../lib/i18n/store.svelte'

  let {
    canBack,
    canForward,
    onPrev,
    onNext,
    onRefresh,
    onJump,
    onFilter,
  }: {
    canBack: boolean
    canForward: boolean
    onPrev: () => void
    onNext: () => void
    onRefresh: () => void
    onJump: (date: string) => void
    onFilter: (query: string) => void
  } = $props()

  // Debounce the search box so we don't re-filter the whole feed on every keystroke.
  let filterTimer: ReturnType<typeof setTimeout> | null = null
  function onSearchInput(e: Event): void {
    const value = (e.currentTarget as HTMLInputElement).value
    if (filterTimer) clearTimeout(filterTimer)
    filterTimer = setTimeout(() => { onFilter(value) }, 150)
  }
  onDestroy(() => { if (filterTimer) clearTimeout(filterTimer) })

  function onDateChange(e: Event): void {
    const value = (e.currentTarget as HTMLInputElement).value
    if (value) onJump(value)
  }
</script>

<div class="toolbar">
  <button
    class="btn"
    disabled={!canBack}
    aria-label={t('daily.toolbar.prev')}
    title={t('daily.toolbar.prev')}
    onclick={() => onPrev()}
  >‹</button>
  <button
    class="btn"
    disabled={!canForward}
    aria-label={t('daily.toolbar.next')}
    title={t('daily.toolbar.next')}
    onclick={() => onNext()}
  >›</button>
  <button
    class="btn"
    aria-label={t('daily.toolbar.refresh')}
    title={t('daily.toolbar.refresh')}
    onclick={() => onRefresh()}
  >⟳</button>
  <input
    class="date"
    type="date"
    aria-label={t('daily.toolbar.calendar')}
    title={t('daily.toolbar.calendar')}
    onchange={onDateChange}
  />
  <input
    class="search"
    type="search"
    placeholder={t('daily.toolbar.find')}
    aria-label={t('daily.toolbar.find')}
    oninput={onSearchInput}
  />
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: Canvas;
    color: CanvasText;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    flex: 0 0 auto;
  }
  .btn {
    font: inherit;
    font-size: 15px;
    line-height: 1;
    min-width: 26px;
    height: 26px;
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 5px;
    background: color-mix(in srgb, CanvasText 4%, transparent);
    color: CanvasText;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: color-mix(in srgb, CanvasText 10%, transparent); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .date, .search {
    font: inherit;
    height: 26px;
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 5px;
    background: Canvas;
    color: CanvasText;
    padding: 0 6px;
    box-sizing: border-box;
  }
  .search { flex: 1 1 auto; min-width: 60px; }
</style>
