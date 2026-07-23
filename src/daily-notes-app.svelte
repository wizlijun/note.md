<!-- src/daily-notes-app.svelte — standalone Daily Notes window. Bootstraps its
     own webview state, then hosts the toolbar + feed/page views with browser-style
     back/forward navigation (NavHistory).

     View state: a NavHistory<View> is the source of truth; `view`/`canBack`/
     `canForward` are $state mirrors kept in sync by syncView() after every nav
     mutation. Wikilink clicks from the (read-only) feed are classified by
     classifyLink and routed: external → opener, plain .md → main editor window,
     [[date]] → jump within the feed, [[page]] → push a page view. NOTE: clicks
     inside a LIVE OutlineEditor (an active day or a page) are handled by
     OutlineEditor itself (openPageOrCreate → main window), so they do NOT flow
     through this router.

     The feed is kept mounted (hidden via CSS) when a page view is shown so its
     scroll position and lazy date-window survive round-trips; the page view is
     remounted per page (cheap, and each page owns its own tab flush). -->
<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { loadSettings } from './lib/settings.svelte'
  import { loadLocale, t } from './lib/i18n/store.svelte'
  import { loadOutlineDirs } from './lib/outline/dirs.svelte'
  import { refreshSotvault, sotvaultStore } from './lib/sotvault.svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { NavHistory } from './lib/daily/nav-history'
  import { classifyLink } from './lib/daily/link-route'
  import DailyFeed from './components/daily/DailyFeed.svelte'
  import DailyPage from './components/daily/DailyPage.svelte'
  import DailyToolbar from './components/daily/DailyToolbar.svelte'

  type View = { kind: 'feed'; date?: string } | { kind: 'page'; page: string }

  let ready = $state(false)

  const nav = new NavHistory<View>({ kind: 'feed' })
  let view = $state<View>(nav.current())
  let canBack = $state(false)
  let canForward = $state(false)

  let feed = $state<DailyFeed | null>(null)

  /** Mirror NavHistory into $state after any nav mutation; scroll the feed when
   *  landing on a dated feed view. When landing on a PAGE, first tear down the
   *  feed's live editor (flush → detach → closeTab) BEFORE flipping `view` so the
   *  page's editor never coexists with the feed's active-day editor — the outline
   *  singleton stays owned by at most one editor across the transition. */
  async function syncView(): Promise<void> {
    const next = nav.current()
    if (next.kind === 'page') await feed?.deactivateActive()
    view = next
    canBack = nav.canBack()
    canForward = nav.canForward()
    if (view.kind === 'feed' && view.date) {
      await tick()
      void feed?.jumpTo(view.date)
    }
  }

  async function handleLink(raw: string): Promise<void> {
    const r = classifyLink(raw)
    if (!r) return
    if (r.kind === 'external') {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(r.href)
      return
    }
    if (r.kind === 'md') {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('editor_show_and_open_path', { path: r.path })
      return
    }
    if (r.kind === 'feed-date') {
      nav.push({ kind: 'feed', date: r.date })
      void syncView()
      return
    }
    if (r.kind === 'page') {
      nav.push({ kind: 'page', page: r.page })
      void syncView()
    }
  }

  onMount(async () => {
    try {
      await loadSettings()
      await loadLocale()
      await loadOutlineDirs()
      try { await getCurrentWindow().setTitle(t('daily.windowTitle')) } catch { /* no-op */ }
      await refreshSotvault()
    } catch (e) {
      console.error('[daily-notes] init failed:', e)
    }
    ready = true
  })
</script>

<main>
  {#if !ready}
    <p class="msg">…</p>
  {:else if sotvaultStore.vaultRoot === null}
    <p class="msg">{t('daily.needsVault')}</p>
  {:else}
    <DailyToolbar
      {canBack}
      {canForward}
      onPrev={() => { nav.back(); void syncView() }}
      onNext={() => { nav.forward(); void syncView() }}
      onRefresh={() => { void feed?.refresh() }}
      onJump={(date) => { nav.push({ kind: 'feed', date }); void syncView() }}
      onFilter={(q) => feed?.setFilter(q)}
    />
    <!-- Feed stays mounted (hidden when a page is shown) to preserve scroll and
         the lazy date window across navigations. -->
    <div class="view" class:hidden={view.kind !== 'feed'}>
      <DailyFeed bind:this={feed} on:linkclick={(e) => void handleLink(e.detail.raw)} />
    </div>
    {#if view.kind === 'page'}
      <div class="view">
        <!-- DailyPage emits no events: the live OutlineEditor handles its own
             wikilink clicks (openPageOrCreate → main window). -->
        <DailyPage page={view.page} />
      </div>
    {/if}
  {/if}
</main>

<style>
  :global(:root) { color-scheme: light dark; }
  :global(body) { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: Canvas; color: CanvasText; }
  main { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .view { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .hidden { display: none; }
  .msg { color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 13px; padding: 20px; }
</style>
