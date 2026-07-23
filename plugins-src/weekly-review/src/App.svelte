<script lang="ts">
  import { vaultInfo, vaultList, vaultExists, openInEditor, toast } from './lib/bridge'
  import { buildIndex, WEEKLY_DIR, type ReviewIndex } from './lib/scan'
  import { mondayOf } from './lib/isoweek'
  import { t } from './lib/strings'
  import YearCalendar from './lib/components/YearCalendar.svelte'

  let index = $state<ReviewIndex>({ byYear: new Map(), years: [] })
  let selectedYear = $state<number>(new Date().getFullYear())
  let loading = $state(true)
  let noVault = $state(false)
  let vaultRoot: string | null = null

  const now = new Date()
  const todayMondayMs = mondayOf(now).getTime()
  const currentYear = now.getFullYear()

  const weeksForYear = $derived(index.byYear.get(selectedYear))

  function pickDefaultYear(idx: ReviewIndex): number {
    if (idx.byYear.has(currentYear)) return currentYear
    if (idx.years.length) return idx.years[idx.years.length - 1]
    return currentYear
  }

  async function loadFromCache() {
    const { loadCache } = await import('./lib/cache')
    if (!vaultRoot) return
    const names = loadCache(vaultRoot)
    if (names) {
      index = buildIndex(names.map((name) => ({ name, is_dir: false })))
      selectedYear = pickDefaultYear(index)
    }
  }

  async function scan(force = false) {
    try {
      const info = await vaultInfo()
      vaultRoot = info.root
      if (!vaultRoot) {
        noVault = true
        loading = false
        return
      }
      if (!force) await loadFromCache()
      const exists = await vaultExists(WEEKLY_DIR)
      const entries = exists ? await vaultList(WEEKLY_DIR) : []
      index = buildIndex(entries)
      if (!index.byYear.has(selectedYear)) selectedYear = pickDefaultYear(index)
      const { saveCache } = await import('./lib/cache')
      saveCache(vaultRoot, entries.map((e) => e.name))
    } catch (e) {
      await toast('error', t('title'), String(e))
    } finally {
      loading = false
    }
  }

  function goThisWeek() {
    selectedYear = currentYear
  }

  async function onOpen(path: string) {
    try {
      await openInEditor(path)
    } catch (e) {
      await toast('error', t('title'), String(e))
    }
  }

  scan()
</script>

<div class="app">
  <header class="head">
    <div class="yearart">{selectedYear}</div>
    <div class="subtitle">{t('title')}</div>
    <div class="spacer"></div>
    <div class="toolbar">
      <button class="arrow" onclick={() => (selectedYear -= 1)} aria-label="previous year">‹</button>
      <div class="years">
        {#each index.years as y}
          <button class="ychip" class:active={y === selectedYear} onclick={() => (selectedYear = y)}>{y}</button>
        {/each}
      </div>
      <button class="arrow" onclick={() => (selectedYear += 1)} aria-label="next year">›</button>
      <button class="tbtn accent" onclick={goThisWeek}>◎ {t('thisWeek')}</button>
      <button class="tbtn" onclick={() => scan(true)}>↻ {t('rebuild')}</button>
    </div>
  </header>

  {#if noVault}
    <div class="empty">{t('empty.noVault')}</div>
  {:else if !loading && index.years.length === 0}
    <div class="empty">{t('empty.noData')}</div>
  {:else}
    <YearCalendar year={selectedYear} weeks={weeksForYear} {todayMondayMs} {onOpen} />
  {/if}
</div>

<style>
  :global(:root) {
    color-scheme: light dark;
    --bg: #fff; --fg: #22252a; --muted: #9aa0a8; --line: #e6e8ec; --wm: #f0f1f4;
    --chip-bg: #f2f3f5; --chip-active: #2f6feb;
    --accent: #2f6feb; --accent-fg: #fff;
    --past: #f1f2f4; --past-day: #aeb4bc;
    --future-line: #eaecef; --future-day: #c6ccd4;
    --today-ring: #ff9500; --weekend: #e0605a; --yearart: #d21f2b;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #191b1f; --fg: #e7e9ec; --muted: #7b8189; --line: #2a2d33; --wm: #212429;
      --chip-bg: #2a2d33; --chip-active: #3b82f6;
      --accent: #4b8bff; --accent-fg: #fff;
      --past: #212429; --past-day: #6b717a;
      --future-line: #282b31; --future-day: #565c65;
      --today-ring: #ffa726; --weekend: #e0736d; --yearart: #ff5a63;
    }
  }
  :global(body) { margin: 0; background: var(--bg); color: var(--fg); font: 12px/1.35 -apple-system, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif; }
  .head { display: flex; align-items: center; gap: 18px; padding: 14px 22px 6px; }
  .yearart { font-family: 'Snell Roundhand', 'Zapfino', 'Brush Script MT', cursive; font-weight: 700; font-style: italic; font-size: 58px; line-height: 1; color: var(--yearart); }
  .subtitle { font-size: 13px; color: var(--muted); font-weight: 600; letter-spacing: 3px; }
  .spacer { flex: 1; }
  .toolbar { display: flex; align-items: center; gap: 8px; }
  .arrow { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--line); background: var(--chip-bg); color: var(--fg); font-size: 14px; cursor: pointer; }
  .years { display: flex; gap: 5px; }
  .ychip { padding: 4px 11px; border-radius: 20px; background: var(--chip-bg); color: var(--fg); font-weight: 600; font-size: 12px; cursor: pointer; border: none; }
  .ychip.active { background: var(--chip-active); color: #fff; }
  .tbtn { display: flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 8px; border: 1px solid var(--line); background: var(--chip-bg); color: var(--fg); font-weight: 600; font-size: 12px; cursor: pointer; }
  .tbtn.accent { border-color: var(--accent); color: var(--accent); background: transparent; }
  .empty { padding: 60px 22px; text-align: center; color: var(--muted); font-size: 13px; }
</style>
