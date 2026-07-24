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
  // Same global styles as the main window so the outline (bullets, fold
  // indicators, typography, theme vars) renders identically to the main
  // 大纲笔记 view — this is a separate webview and would otherwise miss them.
  import './styles/app.css'
  import './styles/editor-base.css'
  import { onMount, onDestroy, tick } from 'svelte'
  import { loadSettings, settings } from './lib/settings.svelte'
  import { loadLocale, t } from './lib/i18n/store.svelte'
  import { loadOutlineDirs } from './lib/outline/dirs.svelte'
  import { refreshSotvault, sotvaultStore } from './lib/sotvault.svelte'
  import { outline } from './lib/outline/store.svelte'
  import { activeTheme } from './lib/active-theme.svelte'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { NavHistory } from './lib/daily/nav-history'
  import { classifyLink } from './lib/daily/link-route'
  import DailyFeed from './components/daily/DailyFeed.svelte'
  import DailyPage from './components/daily/DailyPage.svelte'
  import DailyFocus from './components/daily/DailyFocus.svelte'
  import DailyToolbar from './components/daily/DailyToolbar.svelte'

  type View =
    | { kind: 'feed'; date?: string }
    | { kind: 'page'; page: string }
    | { kind: 'focus'; date: string; path: number[] }

  let ready = $state(false)
  let activeThemeId = $derived(activeTheme.id)
  /** Cleanup for the system-appearance observer set up during theme bootstrap. */
  let stopSystemObserve: (() => void) | null = null
  /** Cleanup for the cross-window settings-changed listener. */
  let unlistenSettings: (() => void) | null = null

  // Outline typography probe: read the theme's live `.moraya-editor` computed
  // font/color (same trick OutlineEditor uses) and expose it as `--outline-*`
  // CSS vars + color on <main>, so the READ-ONLY day views (DailyOutlineView)
  // render with the exact same theme typography/colors as the active editor.
  let probeEl = $state<HTMLDivElement>()
  let outlineTypo = $state('')
  // Bumped after theme slot CSS is (re)applied so the probe re-reads the themed
  // font-size even when the theme id itself didn't change (e.g. 'default') —
  // otherwise the probe captures the pre-theme default size and the outline
  // (tri/bullet/text) renders smaller than the main window.
  let themeCssTick = $state(0)
  $effect(() => {
    void activeThemeId
    void themeCssTick
    const probe = probeEl?.querySelector('.moraya-editor') as HTMLElement | null
    if (!probe) return
    const h1 = probeEl?.querySelector('.moraya-editor h1') as HTMLElement | null
    const hr = probeEl?.querySelector('.moraya-editor hr') as HTMLElement | null
    const raf = requestAnimationFrame(() => {
      const cs = getComputedStyle(probe)
      const bg = cs.backgroundColor
      // Theme's H1 metrics (compiled from `#write h1` → `.moraya-editor h1`) so a
      // day's date header can render in the exact first-level-heading style.
      const h1s = h1 ? getComputedStyle(h1) : null
      const h1Vars = h1s
        ? `--outline-h1-font-size:${h1s.fontSize};--outline-h1-font-weight:${h1s.fontWeight};` +
          `--outline-h1-line-height:${h1s.lineHeight};`
        : ''
      // Theme's <hr> look (compiled from `#write hr` → `.moraya-editor hr`). Themes
      // draw the rule either as a border-top OR as a background bar of some height,
      // so replicate BOTH channels and let each day's divider apply them verbatim.
      const hrs = hr ? getComputedStyle(hr) : null
      const hrVars = hrs
        ? `--outline-hr-border-top:${hrs.borderTopWidth} ${hrs.borderTopStyle} ${hrs.borderTopColor};` +
          `--outline-hr-height:${hrs.height};--outline-hr-bg:${hrs.backgroundColor};`
        : ''
      outlineTypo =
        `--outline-font-family:${cs.fontFamily};--outline-font-size:${cs.fontSize};` +
        `--outline-line-height:${cs.lineHeight};color:${cs.color};` + h1Vars + hrVars +
        (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? `background:${bg};` : '')
    })
    return () => cancelAnimationFrame(raf)
  })

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
    // page / focus 视图各自挂一个编辑器 → 先拆掉 feed 的活动日编辑器,
    // 保证 outline 单例任一时刻只被一个编辑器持有。
    if (next.kind === 'page' || next.kind === 'focus') await feed?.deactivateActive()
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

  /** feed 里点 bullet(zoom-in)→ 进该天的聚焦视图。用 index-path(而非 node id)寻址:
   *  聚焦视图重开 tab 会重解析出不同 id,只有结构性 path 能跨解析对齐(同 DailyDay)。 */
  function handleFocus(date: string, path: number[]): void {
    nav.push({ kind: 'focus', date, path })
    void syncView()
  }

  /** 聚焦视图内变更:bullet 深钻(path=子)或面包屑回退(path=祖先 / null=回该天 feed)。 */
  function handleFocusChange(path: number[] | null): void {
    const cur = nav.current()
    const date = cur.kind === 'focus' ? cur.date : undefined
    if (!date) return
    if (path == null) nav.push({ kind: 'feed', date })
    else nav.push({ kind: 'focus', date, path })
    void syncView()
  }

  // Theme state at component scope so a cross-window settings change can re-run
  // syncSlots() (the main window's Settings emits `settings://changed`).
  let systemDark = false
  let lightAssigned: string | null = null
  let darkAssigned: string | null = null
  let themeReady = false

  /** Re-apply the light/dark theme slots + active theme from the current
   *  `settings.theme`. Idempotent: only re-applies a slot whose id changed. */
  async function syncSlots(): Promise<void> {
    if (!themeReady) return
    const { findThemeById } = await import('./lib/themes.svelte')
    const { applyThemeContent, computeActiveThemeId } = await import('./lib/theme-loader')
    const { setActiveTheme } = await import('./lib/active-theme.svelte')
    const th = settings.theme
    if (th.light !== lightAssigned) {
      const meta = findThemeById(th.light)
      if (meta) await applyThemeContent('light', meta.id)
      lightAssigned = th.light
    }
    if (th.dark !== darkAssigned) {
      const meta = findThemeById(th.dark)
      if (meta) await applyThemeContent('dark', meta.id)
      darkAssigned = th.dark
    }
    setActiveTheme(computeActiveThemeId(th, systemDark))
    // Slot CSS just (re)applied — re-run the typo probe even if the theme id is
    // unchanged, so --outline-* reflects the themed font size.
    themeCssTick++
  }

  /** Load the theme registry + slots, wire system-appearance, apply once.
   *  Mirrors App.svelte so this standalone window renders with the app theme. */
  async function bootstrapTheme(): Promise<() => void> {
    const { loadThemes } = await import('./lib/themes.svelte')
    const { ensureThemeSlots, observePrefersColorScheme } = await import('./lib/theme-loader')
    await loadThemes()
    ensureThemeSlots()
    themeReady = true
    const stop = observePrefersColorScheme((dark) => { systemDark = dark; void syncSlots() })
    await syncSlots()
    return stop
  }

  onMount(async () => {
    // This window's outline store is a separate webview singleton — fold state
    // lives in .notemd/outliner-folds.json (KV), never in the .note.md, so tell
    // serializeDoc to omit collapsed:: for every note edited in this window.
    outline.omitCollapsed = true
    // Allow deliberately emptying a note in this window (the change-sink's
    // "don't overwrite a non-empty note with an empty tree" guard otherwise
    // silently keeps the old content, which reads as an auto-restore).
    outline.allowEmptyWrite = true
    try {
      await loadSettings()
      await loadLocale()
      await loadOutlineDirs()
      try { stopSystemObserve = await bootstrapTheme() } catch (e) { console.warn('[daily-notes] theme init:', e) }
      try { await getCurrentWindow().setTitle(t('daily.windowTitle')) } catch { /* no-op */ }
      await refreshSotvault()
      if (sotvaultStore.vaultRoot) {
        const { loadDailyFolds } = await import('./lib/daily/folds')
        await loadDailyFolds(sotvaultStore.vaultRoot).catch(() => {})
      }
    } catch (e) {
      console.error('[daily-notes] init failed:', e)
    }
    ready = true

    // The main window's Settings emits `settings://changed` after saveSettings().
    // Re-read settings from disk and re-apply theme + locale so this separate
    // webview follows theme switches live (it has its own settings store).
    try {
      const { listen } = await import('@tauri-apps/api/event')
      unlistenSettings = await listen('settings://changed', async () => {
        try {
          await loadSettings()
          await loadLocale()
          await syncSlots()
        } catch (e) { console.warn('[daily-notes] settings resync:', e) }
      })
    } catch (e) { console.warn('[daily-notes] settings listener:', e) }
  })

  onDestroy(() => { stopSystemObserve?.(); unlistenSettings?.() })
</script>

<main data-theme={activeThemeId} style={outlineTypo}>
  <!-- Hidden probe: theme CSS styles `.moraya-editor` per `data-theme`; we read
       its computed font/color to drive the read-only outline typography above. -->
  <div class="typo-probe" data-theme={activeThemeId} aria-hidden="true" bind:this={probeEl}>
    <div class="moraya-editor"><h1></h1><hr /></div>
  </div>
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
      <DailyFeed bind:this={feed}
        on:linkclick={(e) => void handleLink(e.detail.raw)}
        on:focus={(e) => handleFocus(e.detail.date, e.detail.path)} />
    </div>
    {#if view.kind === 'page'}
      <div class="view">
        <!-- Wikilink clicks inside the page editor route back through handleLink
             (onWikilink → linkclick), so navigation stays in-window. -->
        <DailyPage page={view.page} on:linkclick={(e) => void handleLink(e.detail.raw)} />
      </div>
    {:else if view.kind === 'focus'}
      <div class="view">
        <!-- zoom 聚焦视图:只显示该节点子树,顶部日期面包屑 zoom-out。深钻/回退经
             focuschange 更新视图;path=null → 回该天 feed。 -->
        <DailyFocus date={view.date} path={view.path} rootLabel={view.date}
          on:linkclick={(e) => void handleLink(e.detail.raw)}
          on:focuschange={(e) => handleFocusChange(e.detail.path)} />
      </div>
    {/if}
  {/if}
</main>

<style>
  :global(:root) { color-scheme: light dark; }
  :global(body) { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; background: Canvas; color: CanvasText; }
  main { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .view { flex: 1 1 auto; min-height: 0; overflow: hidden; }
  .hidden { display: none; }
  .msg { color: color-mix(in srgb, CanvasText 55%, transparent); font-size: 13px; padding: 20px; }
  .typo-probe { position: absolute; left: -9999px; top: 0; width: 0; height: 0; visibility: hidden; pointer-events: none; }
</style>
