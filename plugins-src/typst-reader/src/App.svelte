<script lang="ts">
  import { onMount, tick } from 'svelte'
  import Page from './components/Page.svelte'
  import {
    cancelRender, downloadFonts, fontDownloadStatus, loadBookStyleRule, locale, onDocument,
    renderDocument, renderNext, saveBookStyleRule,
    type BookStyleRule, type FontStatus, type TypesetDocument, type RenderResult,
  } from './lib/bridge'

  const zh = locale().startsWith('zh')
  let document = $state<TypesetDocument>()
  let status = $state<'idle' | 'rendering' | 'ready' | 'error'>('idle')
  let cacheKey = $state('')
  let pageCount = $state(0)
  let error = $state('')
  let zoom = $state(1)
  let progress = $state<RenderResult>()
  let elapsed = $state(0)
  let startedAt = 0
  let pagesElement = $state<HTMLElement>()
  let scrollTop = $state(0)
  let viewportHeight = $state(900)
  let active: { controller: AbortController; renderId?: string } | undefined
  let destroyed = false
  const renderingMore = $derived(status === 'rendering' || (status === 'ready' && !!progress && !progress.complete && !error))
  const pageStride = $derived(1123 * zoom + 22)
  const firstPage = $derived(Math.max(0, Math.floor(Math.max(0, scrollTop - 24) / pageStride) - 2))
  const lastPage = $derived(Math.min(pageCount, firstPage + Math.ceil(viewportHeight / pageStride) + 5))
  const visiblePages = $derived(Array.from({ length: Math.max(0, lastPage - firstPage) }, (_, offset) => firstPage + offset))
  const progressLabel = $derived(
    progress?.stage === 'rendering'
      ? (zh ? `正在排版，已完成 ${progress.completed_chunks}/${progress.total_chunks} 批，${pageCount} 页` : `Typesetting: ${progress.completed_chunks}/${progress.total_chunks} batches, ${pageCount} pages`)
      : progress?.stage === 'preparing'
        ? (zh ? '正在准备正文、字体与排版缓存…' : 'Preparing content, fonts and page cache…')
        : (zh ? '正在等待排版任务…' : 'Waiting for typesetting…')
  )
  let contextMenu = $state<{ x: number; y: number }>()
  let contextMenuElement = $state<HTMLDivElement>()
  let bookStyle = $state<BookStyleRule>('auto')
  let settingsPromise: Promise<void> | undefined
  let settingsError = $state('')
  let savingRule = $state(false)
  let fontStatus = $state<FontStatus>()
  let fontError = $state('')
  let fontController: AbortController | undefined
  const zoomLevels = [0.75, 1, 1.25, 1.5]
  const bookStyleRules: { value: BookStyleRule; zh: string; en: string }[] = [
    { value: 'auto', zh: '自动（根据正文语言）', en: 'Automatic (content language)' },
    { value: 'wonderous-book', zh: 'Wonderous Book', en: 'Wonderous Book' },
    { value: 'aiwriter-book', zh: '中文书籍（CJK）', en: 'CJK Book' },
  ]

  function cancel(job: NonNullable<typeof active>) {
    job.controller.abort()
    if (job.renderId) void cancelRender(job.renderId).catch(() => {})
  }

  function poll(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      const finish = () => {
        window.clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = window.setTimeout(finish, 250)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }

  function ensureSettings() {
    return settingsPromise ??= loadBookStyleRule()
      .then(value => { if (!destroyed) bookStyle = value })
      .catch(() => {})
  }

  async function open(next: TypesetDocument) {
    if (active) cancel(active)
    const job = { controller: new AbortController(), renderId: undefined as string | undefined }
    active = job
    document = next
    status = 'rendering'
    error = ''
    progress = undefined
    cacheKey = ''
    pageCount = 0
    scrollTop = 0
    startedAt = Date.now()
    elapsed = 0
    const stale = () => destroyed || job.controller.signal.aborted || active !== job
    try {
      await ensureSettings()
      if (stale()) return
      let result = await renderDocument(next, bookStyle)
      job.renderId = result.render_id
      if (stale()) { cancel(job); return }
      while (!stale()) {
        progress = result
        cacheKey = result.cache_key
        pageCount = result.page_count
        if (pageCount > 0) status = 'ready'
        if (result.stage === 'error' || result.stage === 'cancelled') {
          throw new Error(result.error || (zh ? '排版任务已停止，请重试。' : 'Typesetting stopped. Please retry.'))
        }
        if (result.complete) {
          status = 'ready'
          return
        }
        await poll(job.controller.signal)
        if (stale()) return
        result = await renderNext(result.render_id)
      }
    } catch (value) {
      if (stale()) return
      error = value instanceof Error ? value.message : String(value)
      status = pageCount > 0 ? 'ready' : 'error'
      // Keep the session's cached pages available until retry, navigation or teardown.
    }
  }

  $effect(() => {
    const node = pagesElement
    if (!node) return
    const measure = () => { viewportHeight = node.clientHeight || 900 }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  })

  async function openContextMenu(event: MouseEvent) {
    if ((event.target as HTMLElement | null)?.closest('.reader-menu')) return
    event.preventDefault()
    const width = 238
    const height = 430
    contextMenu = {
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    }
    await tick()
    contextMenuElement?.focus()
  }

  async function setZoom(value: number) {
    const position = Math.max(0, scrollTop - 24) / pageStride
    zoom = value
    const node = pagesElement
    const nextScrollTop = 24 + position * (1123 * value + 22)
    scrollTop = nextScrollTop
    contextMenu = undefined
    // Commit the new virtual canvas height before assigning scrollTop; the
    // browser otherwise clamps positions against the old height when zooming in.
    await tick()
    if (node && pagesElement === node) node.scrollTop = nextScrollTop
  }

  async function setBookStyle(value: BookStyleRule) {
    if (savingRule || value === bookStyle) {
      contextMenu = undefined
      return
    }
    savingRule = true
    settingsError = ''
    try {
      await ensureSettings()
      if (destroyed) return
      await saveBookStyleRule(value)
      if (destroyed) return
      bookStyle = value
      contextMenu = undefined
      if (document && !destroyed) void open(document)
    } catch (value) {
      settingsError = value instanceof Error ? value.message : String(value)
    } finally {
      savingRule = false
    }
  }

  async function downloadFontBundle(style: 'cjk' | 'wonderous') {
    if (fontStatus?.stage === 'downloading') return
    fontController?.abort()
    const controller = new AbortController()
    fontController = controller
    fontError = ''
    try {
      let result = await downloadFonts(style)
      while (!destroyed && !controller.signal.aborted && result.stage === 'downloading') {
        fontStatus = result
        await poll(controller.signal)
        if (controller.signal.aborted) return
        result = await fontDownloadStatus()
      }
      if (destroyed || controller.signal.aborted) return
      fontStatus = result
      if (result.stage === 'error') fontError = result.error || (zh ? '字体下载失败。' : 'Font download failed.')
      if (result.stage === 'complete' && document) void open(document)
    } catch (value) {
      if (!destroyed && !controller.signal.aborted) fontError = value instanceof Error ? value.message : String(value)
    }
  }

  function dismissContextMenu(event: PointerEvent) {
    if (!contextMenu || (event.target as HTMLElement | null)?.closest('.reader-menu')) return
    contextMenu = undefined
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!contextMenu || event.key !== 'Escape') return
    event.preventDefault()
    contextMenu = undefined
  }

  onMount(() => {
    const off = onDocument((next) => { void open(next) })
    const clock = window.setInterval(() => { if (renderingMore) elapsed = Math.floor((Date.now() - startedAt) / 1000) }, 1000)
    return () => {
      destroyed = true
      off()
      window.clearInterval(clock)
      fontController?.abort()
      if (active) cancel(active)
    }
  })
</script>

<svelte:window onpointerdown={dismissContextMenu} onkeydown={handleKeydown} />

<main class="ui-surface" oncontextmenu={openContextMenu}>
  {#if status === 'idle'}
    <section class="state">{zh ? '正在载入文档…' : 'Loading document…'}</section>
  {:else if status === 'rendering'}
    <section class="state" role="status"><div class="spinner"></div><strong>{progressLabel}</strong><span>{zh ? `已等待 ${elapsed} 秒；首批页面就绪后即可阅读。` : `${elapsed}s elapsed; ready pages will appear immediately.`}</span>{#if elapsed >= 20}<span>{zh ? '此任务耗时较长，仍在后台处理。可以切换文档或稍后重试。' : 'This task is taking longer; processing continues in the background.'}</span>{/if}</section>
  {:else if status === 'error'}
    <section class="state error" role="alert"><strong>{zh ? '无法排版这份文档' : 'Could not typeset this document'}</strong><span>{error}</span>{#if document}<button type="button" onclick={() => open(document!)}>{zh ? '重试' : 'Retry'}</button>{/if}</section>
  {:else}
    <section bind:this={pagesElement} class="pages" onscroll={() => { if (pagesElement) scrollTop = pagesElement.scrollTop }} role="document" aria-label={zh ? '排版页面' : 'Typeset pages'} style={`--zoom:${zoom}`}>
      <div class="scaled" style={`width:${794 * zoom}px;height:${Math.max(0, pageCount * pageStride - 22)}px`}>
        {#each visiblePages as index (`${cacheKey}:${index}`)}
          <div class="page-slot" style={`top:${index * pageStride}px;height:${1123 * zoom}px`}>
            <div class="page-scale"><Page {cacheKey} {index} label={`${zh ? '第' : 'Page '}${index + 1}${zh ? ' 页' : ''}`} /></div>
          </div>
        {/each}
      </div>
    </section>
    {#if renderingMore}<div class="progress" role="status"><div class="spinner small"></div>{progressLabel} · {elapsed}s</div>{/if}
    {#if error}<div class="retry-toast" role="alert"><span>{error}</span><button type="button" onclick={() => document && open(document)}>{zh ? '后续页面排版失败，重试' : 'More pages failed. Retry'}</button></div>{/if}
  {/if}
  {#if fontStatus?.stage === 'downloading'}
    <div class="font-notice" role="status">{zh ? `正在下载字体 ${fontStatus.completed}/${fontStatus.total}…` : `Downloading fonts ${fontStatus.completed}/${fontStatus.total}…`}</div>
  {:else if fontError}
    <div class="font-notice error" role="alert">{fontError}</div>
  {/if}
  {#if contextMenu}
    <div
      bind:this={contextMenuElement}
      class="reader-menu menu-panel"
      role="menu"
      aria-label={zh ? '排版设置' : 'Typesetting settings'}
      tabindex="-1"
      style={`left:${contextMenu.x}px;top:${contextMenu.y}px`}
    >
      <div class="menu-label">{zh ? '排版模板' : 'Typesetting template'}</div>
      {#each bookStyleRules as rule}
        <button
          type="button"
          class="setting-row menu-row"
          class:active={bookStyle === rule.value}
          role="menuitemradio"
          aria-checked={bookStyle === rule.value}
          disabled={savingRule}
          onclick={() => setBookStyle(rule.value)}
        ><span>{zh ? rule.zh : rule.en}</span><span class="check" aria-hidden="true">{bookStyle === rule.value ? '✓' : ''}</span></button>
      {/each}
      <div class="menu-sep" role="separator"></div>
      <div class="menu-label">{zh ? '开源字体 · 安装到 ~/Library/Fonts' : 'Open fonts · install to ~/Library/Fonts'}</div>
      {#if bookStyle !== 'wonderous-book'}
        <button type="button" class="setting-row menu-row" role="menuitem" disabled={fontStatus?.stage === 'downloading'} onclick={() => downloadFontBundle('cjk')}>
          {zh ? '下载中文模板字体（约 34 MB）' : 'Download CJK fonts (about 34 MB)'}
        </button>
      {/if}
      {#if bookStyle !== 'aiwriter-book'}
        <button type="button" class="setting-row menu-row" role="menuitem" disabled={fontStatus?.stage === 'downloading'} onclick={() => downloadFontBundle('wonderous')}>
          {zh ? '下载英文模板字体' : 'Download English font'}
        </button>
      {/if}
      {#if fontStatus?.stage === 'downloading'}<div class="menu-label" role="status">{zh ? `正在下载 ${fontStatus.completed}/${fontStatus.total} 款字体…` : `Downloading ${fontStatus.completed}/${fontStatus.total} fonts…`}</div>{/if}
      {#if fontStatus?.stage === 'complete'}<div class="menu-label" role="status">{zh ? '字体已安装，正在重新排版。' : 'Fonts installed; retypesetting.'}</div>{/if}
      {#if fontError}<div class="settings-error" role="alert">{fontError}</div>{/if}
      <div class="menu-sep" role="separator"></div>
      <div class="menu-label">{zh ? '页面缩放' : 'Page zoom'}</div>
      {#each zoomLevels as level}
        <button
          type="button"
          class="setting-row menu-row"
          class:active={zoom === level}
          role="menuitemradio"
          aria-checked={zoom === level}
          onclick={() => setZoom(level)}
        ><span>{Math.round(level * 100)}%</span><span class="check" aria-hidden="true">{zoom === level ? '✓' : ''}</span></button>
      {/each}
      {#if settingsError}<div class="settings-error" role="alert">{settingsError}</div>{/if}
    </div>
  {/if}
</main>

<style>
  :global(html), :global(body), :global(#app) { margin: 0; height: 100%; overflow: hidden; }
  :global(body) { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: CanvasText; background: Canvas; }
  main { height: 100%; display: flex; flex-direction: column; min-width: 0; }
  button { font: inherit; color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 6px; background: Canvas; padding: 5px 8px; }
  button { cursor: pointer; }
  button:hover { background: color-mix(in srgb, CanvasText 7%, Canvas); }
  .state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 9px; color: GrayText; font-size: 12px; padding: 30px; text-align: center; }
  .state strong { color: CanvasText; font-size: 14px; }
  .state button { margin-top: 6px; }
  .state.error span { color: #b42318; max-width: 700px; overflow-wrap: anywhere; }
  .spinner { width: 20px; height: 20px; border: 2px solid color-mix(in srgb, CanvasText 15%, transparent); border-top-color: AccentColor; border-radius: 50%; animation: spin .8s linear infinite; }
  .spinner.small { width: 11px; height: 11px; border-width: 1.5px; }
  .pages { flex: 1; overflow: auto; background: color-mix(in srgb, CanvasText 9%, Canvas); scroll-padding-top: 24px; }
  .scaled { margin: 24px auto; position: relative; }
  .page-slot { position: absolute; width: 100%; }
  .page-scale { position: absolute; inset: 0 auto auto 0; transform: scale(var(--zoom)); transform-origin: top left; }
  .reader-menu { position: fixed; z-index: 20; width: 238px; box-sizing: border-box; }
  .setting-row { width: 100%; min-height: 30px; justify-content: space-between; border: 0; border-radius: 5px; background: none; text-align: left; }
  .menu-label { padding: 3px 9px 4px; color: GrayText; font-size: 11px; }
  .check { width: 14px; text-align: center; }
  .settings-error { padding: 6px 9px 3px; color: #b42318; font-size: 11px; overflow-wrap: anywhere; }
  .progress, .retry-toast { position: fixed; right: 14px; bottom: 14px; z-index: 10; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, .14); background: color-mix(in srgb, Canvas 92%, transparent); backdrop-filter: blur(18px); }
  .font-notice { position: fixed; left: 14px; bottom: 14px; z-index: 10; padding: 8px 10px; border-radius: 8px; background: Canvas; box-shadow: 0 4px 16px rgba(0, 0, 0, .14); font-size: 12px; }
  .font-notice.error { color: #b42318; max-width: min(400px, 80vw); overflow-wrap: anywhere; }
  .progress { display: flex; align-items: center; gap: 7px; padding: 7px 10px; color: GrayText; font-size: 11px; }
  .retry-toast { color: #b42318; padding: 7px 10px; max-width: min(500px, 80vw); display: flex; flex-direction: column; gap: 6px; font-size: 12px; overflow-wrap: anywhere; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
