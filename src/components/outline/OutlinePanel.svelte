<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import { outlineGate, setOutlineWidth, setOutlineWidthLive, setOutlineVisible, outlineAppliesTo } from '../../lib/outline/gate.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import { outline, companionPathFor } from '../../lib/outline/store.svelte'
  import { parseOutline } from '../../lib/outline/markdown'
  import { createTree, childrenOf, type OutlineTree, type OutlineNode as NodeT } from '../../lib/outline/model'
  import { pageNameOf } from '../../lib/outline/backlinks'
  import { ensureOutlineFile } from '../../lib/outline/create'
  import { tabs, openFile } from '../../lib/tabs.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import ReadonlyNode from './ReadonlyNode.svelte'

  import { activeTheme } from '../../lib/active-theme.svelte'
  import { ensureIndex, teardownIndex, openPageOrCreate } from '../../lib/outline/backlinks-io.svelte'
  import BacklinksSection from './BacklinksSection.svelte'

  let { tab }: { tab: Tab | null } = $props()

  // Whether the current tab has an outline preview. Drives body state + button enablement.
  let applicable = $derived(tab != null && outlineAppliesTo(tab))
  let companionPath = $derived(applicable && tab ? companionPathFor(tab.filePath) : null)

  // 伴生文件已作为 tab 打开时镜像其实时内容(spec §4:以 tab 为准),否则读盘
  let mirrorTab = $derived(companionPath ? tabs.find(t => t.filePath === companionPath) ?? null : null)
  let diskText = $state<string | null>(null)
  let tree = $derived<OutlineTree>(
    mirrorTab ? parseOutline(mirrorTab.currentContent)
    : diskText != null ? parseOutline(diskText)
    : createTree())
  let collapsed = new SvelteSet<string>()

  // Theme-driven typography: measured from an offscreen probe (see effect below).
  let activeThemeId = $derived(activeTheme.id)
  let probeEl = $state<HTMLDivElement>()
  let typo = $state({ family: '', size: '', line: '', fg: '', bg: '' })

  // 读盘 + watch:仅在无镜像 tab 时生效
  $effect(() => {
    const path = companionPath
    if (!path || mirrorTab) { diskText = null; return }
    let alive = true
    let unwatch: (() => void) | null = null
    void (async () => {
      const { exists, readTextFile, watchImmediate } = await import('@tauri-apps/plugin-fs')
      const load = async () => {
        const text = (await exists(path).catch(() => false))
          ? await readTextFile(path).catch(() => null) : null
        if (alive) diskText = text
      }
      await load()
      if (!alive) return
      let timer: ReturnType<typeof setTimeout> | null = null
      watchImmediate(path, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { void load() }, 200)
      }).then(s => { if (alive) unwatch = s; else s() }).catch(() => {})
    })()
    return () => { alive = false; if (unwatch) { try { unwatch() } catch { /* ignore */ } } }
  })

  // 背链索引生命周期(与旧面板一致)
  // 只读共享索引,自愈用: backlinkIndex 被别处 teardown 置 null 时触发重建
  $effect(() => { void outline.backlinkIndex; if (applicable && outlineGate.visible && tab) void ensureIndex(tab.filePath) })
  $effect(() => () => { teardownIndex() })  // unmount 兜底

  // Read the theme's base body typography (font-family/size/line-height, which
  // live on `.moraya-editor` under `[data-theme=<id>]`) and expose as CSS vars.
  // rAF waits for the theme slot CSS to apply after an id change.
  $effect(() => {
    void activeThemeId
    const probe = probeEl?.querySelector('.moraya-editor') as HTMLElement | null
    if (!probe) return
    const raf = requestAnimationFrame(() => {
      const cs = getComputedStyle(probe)
      // 同时取主题的前景/背景色，让面板跟随 theme（背景透明时保持系统 Canvas）
      const bg = cs.backgroundColor
      typo = {
        family: cs.fontFamily, size: cs.fontSize, line: cs.lineHeight,
        fg: cs.color,
        bg: bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : '',
      }
    })
    return () => cancelAnimationFrame(raf)
  })

  let roots = $derived(childrenOf(tree, null))

  // 搜索：过滤当前文档大纲。visibleIds 非 null 时仅保留命中节点及其祖先路径。
  let searchOpen = $state(false)
  let searchQuery = $state('')
  let searchInputEl: HTMLInputElement | undefined = $state()
  let visibleIds = $derived.by<Set<string> | null>(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null
    const nodes = tree.nodes
    const set = new Set<string>()
    for (const n of nodes.values()) {
      if (!n.content.toLowerCase().includes(q)) continue
      let cur: NodeT | undefined = n
      while (cur && !set.has(cur.id)) { set.add(cur.id); cur = cur.parentId ? nodes.get(cur.parentId) : undefined }
    }
    return set
  })
  let visibleRoots = $derived(visibleIds ? roots.filter((r) => visibleIds!.has(r.id)) : roots)

  function toggleSearch() {
    searchOpen = !searchOpen
    if (!searchOpen) searchQuery = ''
    else queueMicrotask(() => searchInputEl?.focus())
  }
  function onSearchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); searchQuery = ''; searchOpen = false }
  }

  async function openNoteTab() {
    if (!companionPath) return
    await ensureOutlineFile(companionPath)
    await openFile(companionPath)
  }
  function onNodeClick(_n: NodeT) { void openNoteTab() }   // spec §4:点击节点跳转大纲 tab
  function onPageClick(target: string) { void openPageOrCreate(target) }

  let startX = 0
  let startW = 0

  function onSplitterDown(e: PointerEvent) {
    startX = e.clientX
    startW = outlineGate.width
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onSplitterMove(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    setOutlineWidthLive(startW + (startX - e.clientX))
  }
  function onSplitterUp(e: PointerEvent) {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    void setOutlineWidth(outlineGate.width)
  }
</script>

<aside
  class="outline-panel"
  oncontextmenu={(e) => e.preventDefault()}
  style="width: {outlineGate.width}px; --outline-font-family: {typo.family}; --outline-font-size: {typo.size}; --outline-line-height: {typo.line};{typo.fg ? ` color: ${typo.fg};` : ''}{typo.bg ? ` background: ${typo.bg};` : ''}"
>
  <div class="typo-probe" data-theme={activeThemeId} aria-hidden="true" bind:this={probeEl}>
    <div class="moraya-editor"></div>
  </div>
  <div
    class="splitter"
    onpointerdown={onSplitterDown}
    onpointermove={onSplitterMove}
    onpointerup={onSplitterUp}
  ></div>
  <header>
    <button class="hbtn" title={t('outline.hide')} aria-label={t('outline.hide')} onclick={() => void setOutlineVisible(false)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="15" y1="3" x2="15" y2="21" />
        <polyline points="8 9 11 12 8 15" />
      </svg>
    </button>
    <span class="title">{t('outline.title')}</span>
    <button class="hbtn" class:on={searchOpen} title={t('outline.search')} aria-label={t('outline.search')} disabled={!applicable} onclick={toggleSearch}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    </button>
    <button class="hbtn" title={t('outline.editNote')} aria-label={t('outline.editNote')} disabled={!companionPath} onclick={() => void openNoteTab()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      </svg>
    </button>
  </header>
  {#if searchOpen}
    <div class="search-row">
      <input
        bind:this={searchInputEl}
        class="search-input"
        type="text"
        placeholder={t('outline.searchPlaceholder')}
        bind:value={searchQuery}
        onkeydown={onSearchKeydown}
      />
      {#if searchQuery}
        <button class="hbtn" title={t('common.close')} aria-label={t('common.close')} onclick={() => (searchQuery = '')}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      {/if}
    </div>
  {/if}
  {#if !applicable}
    <div class="body">
      <p class="empty">{tab == null ? t('outline.noDocument') : t('outline.notApplicable')}</p>
    </div>
  {:else}
    <div class="body" role="tree">
      {#each visibleRoots as node (node.id)}
        <ReadonlyNode {node} depth={0} {tree} {collapsed} {onNodeClick} {onPageClick} />
      {/each}
      {#if visibleRoots.length === 0}
        <p class="empty">{visibleIds ? t('outline.noSearchResults') : t('outline.empty')}</p>
      {/if}
    </div>
    {#if !visibleIds}
      <BacklinksSection page={tab ? pageNameOf(tab.filePath) : null} excludeFile={companionPath} />
    {/if}
  {/if}
</aside>

<style>
  .outline-panel {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color, #3333);
    overflow: hidden;
  }
  .splitter {
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 4px;
    cursor: col-resize;
    z-index: 5;
    touch-action: none;
  }
  header {
    padding: 8px 12px;
    font-size: 13px;
    font-weight: 600;
    border-bottom: 1px solid var(--border-color, #3333);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .title { flex: 1; }
  .hbtn {
    display: inline-flex; align-items: center; justify-content: center;
    border: 0; background: transparent; cursor: pointer;
    padding: 3px; border-radius: 4px; opacity: 0.7;
  }
  .hbtn svg { display: block; }
  .hbtn:hover:not(:disabled) { background: rgba(0,0,0,0.08); opacity: 1; }
  .hbtn:disabled { opacity: 0.25; cursor: default; }
  .hbtn.on { background: rgba(0,0,0,0.1); opacity: 1; }
  .search-row {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 8px; border-bottom: 1px solid var(--border-color, #3333);
  }
  .search-input {
    flex: 1; min-width: 0; font-size: 12px; padding: 3px 6px;
    border: 1px solid var(--border-color, #3335); border-radius: 4px;
    background: var(--input-bg, transparent); color: inherit; outline: none;
  }
  .search-input:focus { outline: 1px solid var(--accent-color, #4a80d4); }
  .body { flex: 1; overflow-y: auto; padding: 8px; font-family: var(--outline-font-family); }
  .empty { opacity: 0.5; font-size: 12px; }
  .typo-probe {
    position: absolute;
    left: -9999px; top: 0;
    width: 0; height: 0;
    visibility: hidden;
    pointer-events: none;
  }
  @media (prefers-color-scheme: dark) {
    .hbtn:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
    .hbtn.on { background: rgba(255,255,255,0.15); }
  }
</style>
