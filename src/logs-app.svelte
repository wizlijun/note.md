<!-- src/logs-app.svelte — standalone Logs window (View ▸ View Logs, or tray
     git-sync entry which presets the category filter to git-sync). -->
<script lang="ts">
  import { onMount } from 'svelte'
  import { loadLocale, t } from './lib/i18n/store.svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { createLogsStore } from './lib/logs/logs-store.svelte'
  import type { LogLine } from './lib/logs/console-bridge'

  const store = createLogsStore()
  let sourceFilter = $state<'all' | 'backend' | 'frontend'>('all')
  let levelFilter = $state<'all' | 'debug' | 'info' | 'warn' | 'error'>('all')
  let search = $state('')
  let autoScroll = $state(true)
  let ready = $state(false)
  let logEnd: HTMLDivElement | undefined

  onMount(() => {
    let stop: (() => void) | undefined
    ;(async () => {
      await loadLocale()
      try { await getCurrentWindow().setTitle(t('logs.title')) } catch { /* no-op */ }
      stop = await store.start()
      ready = true
    })()
    return () => stop?.()
  })

  // category filter groups every plugin:<id> under the single "plugin" bucket.
  function matchCategory(line: LogLine): boolean {
    const f = store.categoryFilter
    if (f === 'all') return true
    if (f === 'plugin') return line.category.startsWith('plugin:')
    return line.category === f
  }

  const filtered = $derived(
    store.lines.filter((l) =>
      (sourceFilter === 'all' || l.source === sourceFilter) &&
      matchCategory(l) &&
      (levelFilter === 'all' || l.level === levelFilter) &&
      (search === '' || l.message.toLowerCase().includes(search.toLowerCase())))
  )

  $effect(() => {
    // Re-run on every filtered change; scroll to bottom when enabled.
    filtered.length
    if (autoScroll) logEnd?.scrollIntoView({ block: 'end' })
  })

  function catClass(cat: string): string {
    if (cat === 'git-sync') return 'cat-git'
    if (cat.startsWith('plugin:')) return 'cat-plugin'
    if (cat === 'frontend') return 'cat-frontend'
    return 'cat-core'
  }
</script>

<div class="logs-root">
  <header class="bar">
    <select bind:value={sourceFilter} title={t('logs.source')} aria-label={t('logs.source')}>
      <option value="all">{t('logs.sources.all')}</option>
      <option value="backend">{t('logs.sources.backend')}</option>
      <option value="frontend">{t('logs.sources.frontend')}</option>
    </select>
    <select bind:value={store.categoryFilter} title={t('logs.category')} aria-label={t('logs.category')}>
      <option value="all">{t('logs.categories.all')}</option>
      <option value="core">{t('logs.categories.core')}</option>
      <option value="git-sync">{t('logs.categories.gitSync')}</option>
      <option value="plugin">{t('logs.categories.plugin')}</option>
      <option value="frontend">{t('logs.categories.frontend')}</option>
    </select>
    <select bind:value={levelFilter} title={t('logs.level')} aria-label={t('logs.level')}>
      <option value="all">{t('logs.levels.all')}</option>
      <option value="debug">{t('logs.levels.debug')}</option>
      <option value="info">{t('logs.levels.info')}</option>
      <option value="warn">{t('logs.levels.warn')}</option>
      <option value="error">{t('logs.levels.error')}</option>
    </select>
    <input class="search" type="text" placeholder={t('logs.search')} bind:value={search} />
    <label class="auto"><input type="checkbox" bind:checked={autoScroll} />{t('logs.autoScroll')}</label>
    <button onclick={() => store.clear()}>{t('logs.clear')}</button>
  </header>

  <div class="stream">
    {#if ready && filtered.length === 0}
      <div class="empty">{t('logs.empty')}</div>
    {/if}
    {#each filtered as line, i (i)}
      <div class="row">
        <span class="ts">{line.ts}</span>
        <span class="cat {catClass(line.category)}">[{line.category}]</span>
        <span class="src">[{line.source}]</span>
        <span class="lvl lvl-{line.level}">{line.level}</span>
        <span class="msg">{line.message}</span>
      </div>
    {/each}
    <div bind:this={logEnd}></div>
  </div>
</div>

<style>
  .logs-root { display: flex; flex-direction: column; height: 100vh; background: #1e1e1e; color: #ddd; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 6px 8px; background: #252526; border-bottom: 1px solid #333; flex-wrap: wrap; }
  .bar select, .bar input, .bar button { background: #333; color: #ddd; border: 1px solid #444; border-radius: 4px; padding: 2px 6px; font: inherit; }
  .search { flex: 1; min-width: 120px; }
  .auto { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .stream { flex: 1; overflow-y: auto; padding: 6px 8px; }
  .empty { opacity: 0.5; padding: 16px; text-align: center; }
  .row { display: flex; gap: 8px; padding: 1px 0; align-items: baseline; }
  .ts { color: #777; white-space: nowrap; }
  .src { color: #6a9955; white-space: nowrap; }
  .cat { white-space: nowrap; }
  .cat-git { color: #4fc1ff; }
  .cat-plugin { color: #c586c0; }
  .cat-frontend { color: #4ec9b0; }
  .cat-core { color: #6a9955; }
  .lvl { white-space: nowrap; text-transform: uppercase; }
  .lvl-error { color: #f14c4c; }
  .lvl-warn { color: #cca700; }
  .lvl-debug { color: #888; }
  .lvl-info { color: #ddd; }
  .msg { white-space: pre-wrap; word-break: break-all; }
</style>
