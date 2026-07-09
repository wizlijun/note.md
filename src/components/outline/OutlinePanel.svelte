<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import { outlineGate, outlineShortcuts, setOutlineWidth, setOutlineWidthLive, setOutlineVisible, outlineAppliesTo } from '../../lib/outline/gate.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import OutlineNode from './OutlineNode.svelte'
  import SlashMenu from './SlashMenu.svelte'
  import LinkAutocomplete from './LinkAutocomplete.svelte'
  import NodeContextMenu from './NodeContextMenu.svelte'
  import {
    outline, attachTab, detach, scheduleSyncFromMain, regenerate,
    flushSave, bump, markDirty, pinnedIds,
  } from '../../lib/outline/store.svelte'
  import { childrenOf, newId, calculateOrderBetween, type OutlineNode as NodeT } from '../../lib/outline/model'
  import { moveNodeAfter, moveNodeToChild, deleteNode, subtreeToMarkdown } from '../../lib/outline/commands'
  import { resolveShortcuts, type OutlineCommandId } from '../../lib/outline/shortcuts'
  import { filterSlashItems, applySlashItem, pageLinkQueryAt, confirmPageLink, filterPages, type SlashItem } from '../../lib/outline/completion'
  import { pageCandidates } from '../../lib/outline/backlinks'

  import { requestReveal } from '../../lib/outline/reveal.svelte'
  import { ensureIndex, teardownIndex, openPageOrCreate } from '../../lib/outline/backlinks-io.svelte'
  import BacklinksSection from './BacklinksSection.svelte'

  let { tab }: { tab: Tab | null } = $props()

  // Whether the current tab has an editable outline. Drives body state + button enablement.
  let applicable = $derived(tab != null && outlineAppliesTo(tab))

  // resolved shortcuts：接设置覆盖，随 outlineShortcuts.overrides 变化响应式更新
  let resolved = $derived(resolveShortcuts(outlineShortcuts.overrides))

  // 绑定当前 tab + 主文内容变化驱动同步
  $effect(() => {
    if (applicable && tab) void attachTab(tab.filePath, tab.currentContent)
    else { void flushSave(); detach(); teardownIndex() }
  })
  $effect(() => {
    if (!applicable || !tab) return
    const content = tab.currentContent
    if (outline.mainPath === tab.filePath) scheduleSyncFromMain(content)
  })
  $effect(() => () => { void flushSave(); detach(); teardownIndex() })  // unmount 兜底保存
  $effect(() => { if (applicable && outlineGate.visible && tab) void ensureIndex(tab.filePath) })
  // Close any floating menu whose owning node is no longer in edit mode (e.g. blur → commitEdit).
  $effect(() => {
    if (menu.kind !== 'none' && outline.editingId !== menu.nodeId) {
      menu = { kind: 'none' }
    }
  })
  // Default-editable: an applicable but empty outline gets one ready-to-type
  // root node (no + button needed). Guarded so it fires once, not on every bump.
  $effect(() => {
    void outline.version
    if (!applicable) return
    if (outline.tree.nodes.size === 0 && outline.editingId == null) addRootNote()
  })

  let roots = $derived.by(() => { void outline.version; return childrenOf(outline.tree, null) })

  // 搜索：过滤当前文档大纲。visibleIds 非 null 时仅保留命中节点及其祖先路径。
  let searchOpen = $state(false)
  let searchQuery = $state('')
  let searchInputEl: HTMLInputElement | undefined = $state()
  let visibleIds = $derived.by<Set<string> | null>(() => {
    void outline.version
    const q = searchQuery.trim().toLowerCase()
    if (!q) return null
    const nodes = outline.tree.nodes
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

  function onJump(n: NodeT) { if (n.anchorLine != null) requestReveal(n.anchorLine, n.content) }
  function onPageClick(target: string) { void openPageOrCreate(target) }
  function onDragOp(drag: string, target: string, mode: 'sibling' | 'child') {
    const ok = mode === 'child' ? moveNodeToChild(outline.tree, drag, target) : moveNodeAfter(outline.tree, drag, target)
    if (ok) { bump(); markDirty() }
  }
  function addRootNote() {
    const last = roots[roots.length - 1]
    const node: NodeT = {
      id: newId(), parentId: null, order: calculateOrderBetween(last ? last.order : null, null),
      content: '', collapsed: false, source: 'manual',
    }
    outline.tree.nodes.set(node.id, node)
    outline.editingId = node.id
    bump()   // no markDirty(): an empty node alone must not trigger a save
  }

  // Click in the empty region below the last node → new trailing root node.
  function onBodyClick(e: MouseEvent) {
    if (!applicable) return
    const target = e.target as HTMLElement
    if (target.closest('.node')) return   // clicks on existing rows handled by the node
    addRootNote()
  }
  async function onRegenerate() {
    if (!tab) return
    const { confirm } = await import('@tauri-apps/plugin-dialog')
    if (await confirm(t('outline.regenerateConfirm'), { title: t('outline.regenerate') })) {
      regenerate(tab.currentContent)
    }
  }
  type MenuState =
    | { kind: 'none' }
    | { kind: 'slash'; nodeId: string; start: number; query: string; selected: number; x: number; y: number; el: HTMLTextAreaElement }
    | { kind: 'link'; nodeId: string; start: number; query: string; selected: number; x: number; y: number; el: HTMLTextAreaElement }
  let menu = $state<MenuState>({ kind: 'none' })

  let slashItems = $derived(menu.kind === 'slash' ? filterSlashItems(menu.query) : [])
  let linkPages = $derived(menu.kind === 'link'
    ? filterPages(outline.backlinkIndex ? pageCandidates(outline.backlinkIndex) : [], menu.query)
    : [])

  function menuAnchor(el: HTMLTextAreaElement): { x: number; y: number } {
    const r = el.getBoundingClientRect()
    return { x: Math.min(r.left, window.innerWidth - 220), y: r.bottom + 2 }
  }

  // Invariant: el.value and node.content must be set to the SAME string before bump() so
  // Svelte's `value={node.content}` attribute reconciliation skips the DOM write and the
  // caret position set by setSelectionRange survives without being reset by a Svelte patch.
  function applyToTextarea(el: HTMLTextAreaElement, node: NodeT, text: string, cursor: number) {
    el.value = text
    node.content = text
    el.setSelectionRange(cursor, cursor)
    bump(); markDirty()
  }

  /** 返回 true = 事件被菜单消费（keydown 时 Node 组件会 preventDefault） */
  function onEditorInput(node: NodeT, value: string, cursor: number, el: HTMLTextAreaElement, e?: KeyboardEvent): boolean {
    // --- keydown 阶段：菜单打开时接管导航键 ---
    if (e && menu.kind !== 'none') {
      const count = menu.kind === 'slash' ? slashItems.length : linkPages.length
      if (e.key === 'ArrowDown') { menu.selected = (menu.selected + 1) % Math.max(count, 1); return true }
      if (e.key === 'ArrowUp') { menu.selected = (menu.selected - 1 + Math.max(count, 1)) % Math.max(count, 1); return true }
      if (e.key === 'Escape') { menu = { kind: 'none' }; return true }
      if (e.key === 'Enter') {
        if (menu.kind === 'slash' && slashItems[menu.selected]) { pickSlash(slashItems[menu.selected]); return true }
        if (menu.kind === 'link') { pickPage(linkPages[menu.selected] ?? null); return true }
        menu = { kind: 'none' }
        return false
      }
      return false
    }
    if (e) {
      // `[` 后接着输 `[` → 自动补 `]]` 并开链接菜单（render.cljs:1117）
      if (e.key === '[' && value[cursor - 1] === '[') {
        const text = value.slice(0, cursor) + '[]]' + value.slice(cursor)
        applyToTextarea(el, node, text, cursor + 1)
        menu = { kind: 'link', nodeId: node.id, start: cursor - 1, query: '', selected: 0, ...menuAnchor(el), el }
        return true
      }
      return false
    }
    // --- input 阶段：维护菜单 query / 触发 slash 菜单 ---
    if (menu.kind === 'link') {
      const q = pageLinkQueryAt(value, cursor)
      if (q && q.start === menu.start) menu.query = q.query
      else menu = { kind: 'none' }
      return false
    }
    if (menu.kind === 'slash') {
      const seg = value.slice(menu.start, cursor)
      if (seg.startsWith('/') && !seg.includes(' ')) { menu.query = seg.slice(1); menu.selected = 0 }
      else menu = { kind: 'none' }
      return false
    }
    // `/` 在行首或空格后触发（render.cljs filtered-slash-commands 语义）
    if (value[cursor - 1] === '/' && (cursor === 1 || /\s/.test(value[cursor - 2]))) {
      menu = { kind: 'slash', nodeId: node.id, start: cursor - 1, query: '', selected: 0, ...menuAnchor(el), el }
    }
    return false
  }

  function pickSlash(item: SlashItem) {
    if (menu.kind !== 'slash') return
    const node = outline.tree.nodes.get(menu.nodeId)
    if (node) {
      const r = applySlashItem(menu.el.value, menu.start, menu.el.selectionStart, item)
      applyToTextarea(menu.el, node, r.text, r.cursor)
    }
    menu = { kind: 'none' }
  }

  function pickPage(page: string | null) {
    if (menu.kind !== 'link') return
    const node = outline.tree.nodes.get(menu.nodeId)
    if (node) {
      const r = confirmPageLink(menu.el.value, menu.start, menu.query, page)
      applyToTextarea(menu.el, node, r.text, r.cursor)
    }
    menu = { kind: 'none' }
  }

  let ctxMenu = $state<{ node: NodeT; x: number; y: number } | null>(null)

  function onContextMenu(e: MouseEvent, node: NodeT) {
    ctxMenu = { node, x: e.clientX, y: e.clientY }
  }
  async function onCtxAction(action: string, node: NodeT) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
    if (action === 'jump') onJump(node)
    else if (action === 'copy') await writeText(node.content)
    else if (action === 'copy-subtree') await writeText(subtreeToMarkdown(outline.tree, node.id))
    else if (action === 'copy-ref') { pinnedIds.add(node.id); await writeText(`((${node.id}))`); markDirty() }
    else if (action === 'delete') {
      const { confirm } = await import('@tauri-apps/plugin-dialog')
      const kids = childrenOf(outline.tree, node.id).length
      if (kids === 0 || await confirm(t('outline.deleteConfirm'), { title: t('outline.delete') })) {
        if (deleteNode(outline.tree, node.id)) { bump(); markDirty() }
      }
    }
  }

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

<aside class="outline-panel" style="width: {outlineGate.width}px">
  <div
    class="splitter"
    onpointerdown={onSplitterDown}
    onpointermove={onSplitterMove}
    onpointerup={onSplitterUp}
  ></div>
  <header>
    <button class="hbtn" title={t('outline.hide')} onclick={() => void setOutlineVisible(false)}>«</button>
    <span class="title">{t('outline.title')}</span>
    <button class="hbtn" class:active={searchOpen} title={t('outline.search')} disabled={!applicable} onclick={toggleSearch}>⌕</button>
    <button class="hbtn" title={t('outline.regenerate')} disabled={!applicable} onclick={onRegenerate}>⟳</button>
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
        <button class="hbtn" title={t('common.close')} onclick={() => (searchQuery = '')}>✕</button>
      {/if}
    </div>
  {/if}
  {#if outline.externalConflict}
    <div class="conflict">{t('outline.externalChanged')}</div>
  {/if}
  {#if !applicable}
    <div class="body">
      <p class="empty">{tab == null ? t('outline.noDocument') : t('outline.notApplicable')}</p>
    </div>
  {:else}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="body" role="tree" onclick={onBodyClick}>
      {#each visibleRoots as node (node.id)}
        <OutlineNode {node} depth={0} {resolved} {onJump} {onPageClick} {onEditorInput} {onContextMenu} {onDragOp} {visibleIds} />
      {/each}
      {#if visibleRoots.length === 0}
        <p class="empty">{visibleIds ? t('outline.noSearchResults') : t('outline.empty')}</p>
      {/if}
    </div>
    {#if !visibleIds}
      <BacklinksSection />
    {/if}
  {/if}
  {#if menu.kind === 'slash'}
    <SlashMenu items={slashItems} selected={menu.selected} x={menu.x} y={menu.y} onPick={pickSlash} />
  {:else if menu.kind === 'link'}
    <LinkAutocomplete pages={linkPages} selected={menu.selected} x={menu.x} y={menu.y} onPick={pickPage} />
  {/if}
  {#if ctxMenu}
    <NodeContextMenu node={ctxMenu.node} x={ctxMenu.x} y={ctxMenu.y} onAction={onCtxAction} onClose={() => (ctxMenu = null)} />
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
    background: none; border: none; cursor: pointer; font-size: 14px;
    opacity: 0.6; padding: 0 2px; line-height: 1;
  }
  .hbtn:hover { opacity: 1; }
  .hbtn:disabled { opacity: 0.25; cursor: default; }
  .hbtn.active { opacity: 1; color: var(--accent-color, #4a80d4); }
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
  .conflict {
    background: var(--warn-bg, #fef08a); color: var(--warn-fg, #78350f);
    font-size: 11px; padding: 4px 8px; border-bottom: 1px solid var(--border-color, #3333);
  }
  .body { flex: 1; overflow-y: auto; padding: 8px; }
  .empty { opacity: 0.5; font-size: 12px; }
</style>
