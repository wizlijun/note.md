<script lang="ts">
  import { onMount, tick } from 'svelte'
  import Page from './components/Page.svelte'
  import { locale, onDocument, renderDocument, renderNext, type TypesetDocument } from './lib/bridge'

  const zh = locale().startsWith('zh')
  let document = $state<TypesetDocument>()
  let status = $state<'idle' | 'rendering' | 'ready' | 'error'>('idle')
  let cacheKey = $state('')
  let pageCount = $state(0)
  let error = $state('')
  let renderingMore = $state(false)
  let zoom = $state(1)
  let zoomMenu = $state<{ x: number; y: number }>()
  let zoomMenuElement = $state<HTMLDivElement>()
  let generation = 0
  const zoomLevels = [0.75, 1, 1.25, 1.5]

  async function open(next: TypesetDocument) {
    const current = ++generation
    document = next
    status = 'rendering'
    error = ''
    renderingMore = false
    cacheKey = ''
    pageCount = 0
    try {
      let result = await renderDocument(next)
      if (current !== generation) return
      cacheKey = result.cache_key
      pageCount = result.page_count
      if (result.complete) {
        status = 'ready'
        return
      }
      renderingMore = true
      while (!result.complete) {
        result = await renderNext(result.cache_key)
        if (current !== generation) return
        pageCount = result.page_count
        status = 'ready'
        await tick()
      }
      renderingMore = false
    } catch (value) {
      if (current !== generation) return
      error = value instanceof Error ? value.message : String(value)
      renderingMore = false
      status = pageCount > 0 ? 'ready' : 'error'
    }
  }

  async function openZoomMenu(event: MouseEvent) {
    event.preventDefault()
    const width = 150
    const height = 146
    zoomMenu = {
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    }
    await tick()
    zoomMenuElement?.focus()
  }

  function setZoom(value: number) {
    zoom = value
    zoomMenu = undefined
  }

  function dismissZoomMenu(event: PointerEvent) {
    if (!zoomMenu || (event.target as HTMLElement | null)?.closest('.zoom-menu')) return
    zoomMenu = undefined
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!zoomMenu || event.key !== 'Escape') return
    event.preventDefault()
    zoomMenu = undefined
  }

  onMount(() => onDocument((next) => { void open(next) }))
</script>

<svelte:window onpointerdown={dismissZoomMenu} onkeydown={handleKeydown} onblur={() => { zoomMenu = undefined }} />

<main class="ui-surface">
  {#if status === 'idle'}
    <section class="state">{zh ? '正在载入文档…' : 'Loading document…'}</section>
  {:else if status === 'rendering'}
    <section class="state"><div class="spinner"></div><strong>{zh ? 'Typst 正在排版…' : 'Typesetting with Typst…'}</strong><span>{zh ? '首次打开会生成分页缓存。' : 'The first open creates a paged cache.'}</span></section>
  {:else if status === 'error'}
    <section class="state error" role="alert"><strong>{zh ? '无法排版这份文档' : 'Could not typeset this document'}</strong><span>{error}</span>{#if document}<button type="button" onclick={() => open(document!)}>{zh ? '重试' : 'Retry'}</button>{/if}</section>
  {:else}
    <section class="pages" role="document" aria-label={zh ? '排版页面' : 'Typeset pages'} style={`--zoom:${zoom}`} oncontextmenu={openZoomMenu}>
      <div class="scaled" style={`width:${794 * zoom}px`}>
        {#each Array(pageCount) as _, index}
          <div class="page-slot" style={`height:${1123 * zoom}px`}>
            <div class="page-scale"><Page {cacheKey} {index} label={`${zh ? '第' : 'Page '}${index + 1}${zh ? ' 页' : ''}`} /></div>
          </div>
        {/each}
      </div>
    </section>
    {#if renderingMore}<div class="progress" role="status"><div class="spinner small"></div>{zh ? `继续排版，已完成 ${pageCount} 页…` : `Typesetting more pages… ${pageCount} ready`}</div>{/if}
    {#if error}<button class="retry-toast" type="button" onclick={() => document && open(document)}>{zh ? '后续页面排版失败，重试' : 'More pages failed. Retry'}</button>{/if}
  {/if}
  {#if zoomMenu}
    <div
      bind:this={zoomMenuElement}
      class="zoom-menu menu-panel"
      role="menu"
      aria-label={zh ? '页面缩放' : 'Page zoom'}
      tabindex="-1"
      style={`left:${zoomMenu.x}px;top:${zoomMenu.y}px`}
    >
      {#each zoomLevels as level}
        <button
          type="button"
          class="zoom-row menu-row"
          class:active={zoom === level}
          role="menuitemradio"
          aria-checked={zoom === level}
          onclick={() => setZoom(level)}
        ><span>{Math.round(level * 100)}%</span><span class="check" aria-hidden="true">{zoom === level ? '✓' : ''}</span></button>
      {/each}
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
  .scaled { margin: 24px auto; display: flex; flex-direction: column; gap: 22px; }
  .page-slot { position: relative; width: 100%; flex: 0 0 auto; }
  .page-scale { position: absolute; inset: 0 auto auto 0; transform: scale(var(--zoom)); transform-origin: top left; }
  .zoom-menu { position: fixed; z-index: 20; width: 150px; box-sizing: border-box; }
  .zoom-row { width: 100%; min-height: 30px; justify-content: space-between; border: 0; border-radius: 5px; background: none; text-align: left; }
  .check { width: 14px; text-align: center; }
  .progress, .retry-toast { position: fixed; right: 14px; bottom: 14px; z-index: 10; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, .14); background: color-mix(in srgb, Canvas 92%, transparent); backdrop-filter: blur(18px); }
  .progress { display: flex; align-items: center; gap: 7px; padding: 7px 10px; color: GrayText; font-size: 11px; }
  .retry-toast { color: #b42318; padding: 7px 10px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
