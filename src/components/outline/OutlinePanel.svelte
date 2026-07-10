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
    flushSave, bump, markDirty, pinnedIds, setSelection, clearSelection,
  } from '../../lib/outline/store.svelte'
  import { childrenOf, newId, calculateOrderBetween, setNodeContent, type OutlineNode as NodeT } from '../../lib/outline/model'
  import {
    moveNodeAfter, moveNodeToChild, deleteNode, subtreeToMarkdown,
    deleteNodes, indentNodes, outdentNodes, moveNodesAfter, moveNodesToChild, nodesToMarkdown,
  } from '../../lib/outline/commands'
  import { selectionRoots, rangeBetween } from '../../lib/outline/select'
  import { resolveShortcuts, type OutlineCommandId } from '../../lib/outline/shortcuts'
  import { filterSlashItems, applySlashItem, pageLinkQueryAt, confirmPageLink, filterPages, type SlashItem } from '../../lib/outline/completion'
  import { pageCandidates } from '../../lib/outline/backlinks'

  import { activeTheme } from '../../lib/active-theme.svelte'
  import { requestReveal } from '../../lib/outline/reveal.svelte'
  import { ensureIndex, teardownIndex, openPageOrCreate } from '../../lib/outline/backlinks-io.svelte'
  import BacklinksSection from './BacklinksSection.svelte'

  import { untrack } from 'svelte'

  let { tab }: { tab: Tab | null } = $props()

  // Whether the current tab has an editable outline. Drives body state + button enablement.
  let applicable = $derived(tab != null && outlineAppliesTo(tab))

  // Theme-driven typography: measured from an offscreen probe (see effect below).
  let activeThemeId = $derived(activeTheme.id)
  let probeEl = $state<HTMLDivElement>()
  let typo = $state({ family: '', size: '', line: '', fg: '', bg: '' })

  // resolved shortcuts：接设置覆盖，随 outlineShortcuts.overrides 变化响应式更新
  let resolved = $derived(resolveShortcuts(outlineShortcuts.overrides))

  // 绑定当前 tab + 主文内容变化驱动同步。store 调用必须 untrack：
  // attachTab/flushSave/detach 会同步读写 outline.*（尤其 detach→bump 的
  // version++ 是读+写），在 effect 内被追踪会自我失效 → 无限重跑 →
  // effect_update_depth_exceeded → 整个 UI 冻结（大纲开着关闭文档即触发）。
  $effect(() => {
    if (applicable && tab) {
      const path = tab.filePath
      const content = tab.currentContent
      untrack(() => { void attachTab(path, content) })
    } else {
      untrack(() => { void flushSave(); detach(); teardownIndex() })
    }
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
    const ids = drag.split(',')
    const ok = ids.length > 1
      ? (mode === 'child' ? moveNodesToChild(outline.tree, new Set(ids), target) : moveNodesAfter(outline.tree, new Set(ids), target))
      : (mode === 'child' ? moveNodeToChild(outline.tree, drag, target) : moveNodeAfter(outline.tree, drag, target))
    if (ok) { clearSelection(); bump(); markDirty() }
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
  // 拖拽手势（mousedown/mouseup 落点不同）的 click 会被浏览器派发到共同祖先
  // ——常常就是这个空白容器；只有"按下也在空白处且未形成框选"的完整点击才建节点。
  function onBodyClick(e: MouseEvent) {
    if (!applicable) return
    const target = e.target as HTMLElement
    if (target.closest('.node')) return   // clicks on existing rows handled by the node
    if (bandJustEnded) { bandJustEnded = false; return }  // 框选收尾的 click 不建节点
    const wasEmptyClick = emptyClickOk
    emptyClickOk = false
    if (outline.selectedIds.size > 0) { clearSelection(); return }  // 有选择时点空白只清除
    if (wasEmptyClick) addRootNote()
  }

  // ---------- 多选：框选 + 批量快捷键 ----------
  let bodyEl = $state<HTMLDivElement>()
  let band = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  let bandStart: { x: number; y: number } | null = null
  let bandJustEnded = false
  let emptyClickOk = false   // 本次手势从空白处按下且未成为框选 → 允许建节点

  function bandRect(b: NonNullable<typeof band>) {
    return {
      left: Math.min(b.x0, b.x1), top: Math.min(b.y0, b.y1),
      width: Math.abs(b.x1 - b.x0), height: Math.abs(b.y1 - b.y0),
    }
  }
  // 行内文字上按下：先允许原生选字；拖过节点边界后切换为跨节点多选
  let rowDragFrom: { id: string; top: number; bottom: number } | null = null
  let crossDrag = false

  function nodeIdAt(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    return el?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null
  }
  function onBandDown(e: PointerEvent) {
    if (!applicable || e.button !== 0) return
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id]')
    if (rowEl) {
      // 行上按下：不阻止默认（节点内选字），记录起点行的几何边界等待跨行
      const r = rowEl.getBoundingClientRect()
      rowDragFrom = { id: rowEl.dataset.nodeId!, top: r.top, bottom: r.bottom }
      crossDrag = false
      return
    }
    // 空白处按下：取消 mousedown 默认行为，不启动原生文字选区
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    bandStart = { x: e.clientX, y: e.clientY }
    bodyEl?.setPointerCapture(e.pointerId)
  }
  function onBandMove(e: PointerEvent) {
    if (rowDragFrom) {
      // 用起始行的几何边界（±2px 容差）判定跨行，elementFromPoint 的像素漂移
      // 会把行内选字误判成跨节点多选
      if (!crossDrag && e.clientY >= rowDragFrom.top - 2 && e.clientY <= rowDragFrom.bottom + 2) return
      if (!crossDrag) {
        crossDrag = true
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        outline.editingId = null
      }
      window.getSelection()?.removeAllRanges()
      const over = nodeIdAt(e.clientX, e.clientY)
      if (over) setSelection(rangeBetween(outline.tree, rowDragFrom.id, over))
      return
    }
    if (!bandStart) return
    // 4px 阈值内仍算普通点击（保留点空白建节点）
    if (!band && Math.hypot(e.clientX - bandStart.x, e.clientY - bandStart.y) < 4) return
    if (!band) {
      // 框选一生效就先退出编辑并主动失焦——若拖到松手时才卸载聚焦中的
      // textarea，浏览器会把焦点/滚动跳回原编辑位置
      ;(document.activeElement as HTMLElement | null)?.blur?.()
      outline.editingId = null
    }
    // 指针拖出面板时把矩形夹取在列表区域内，不画到标题栏/其他 UI 上
    const bounds = bodyEl!.getBoundingClientRect()
    const cx = Math.min(Math.max(e.clientX, bounds.left), bounds.right)
    const cy = Math.min(Math.max(e.clientY, bounds.top), bounds.bottom)
    band = { x0: bandStart.x, y0: bandStart.y, x1: cx, y1: cy }
    const r = bandRect(band)
    const hit: string[] = []
    for (const el of bodyEl?.querySelectorAll<HTMLElement>('[data-node-id]') ?? []) {
      const b = el.getBoundingClientRect()
      if (b.left < r.left + r.width && b.left + b.width > r.left && b.top < r.top + r.height && b.top + b.height > r.top) {
        hit.push(el.dataset.nodeId!)
      }
    }
    setSelection(hit)
  }
  function onBandUp(e: PointerEvent) {
    if (rowDragFrom) {
      if (crossDrag) {
        // 跨节点多选收尾：吞掉随后的 click，防止松手处的行进入编辑
        const swallow = (ce: MouseEvent) => { ce.stopPropagation(); ce.preventDefault() }
        window.addEventListener('click', swallow, { capture: true, once: true })
        requestAnimationFrame(() => window.removeEventListener('click', swallow, { capture: true }))
      }
      rowDragFrom = null
      crossDrag = false
      return
    }
    if (!bandStart) return
    bodyEl?.releasePointerCapture(e.pointerId)
    if (band) {
      bandJustEnded = true
      // 松手点若落在某行文字上，随后的 click 会命中该行 span → startEdit →
      // 焦点+滚动跳到该节点。捕获阶段一次性吞掉这次 click。
      const swallow = (ce: MouseEvent) => { ce.stopPropagation(); ce.preventDefault() }
      window.addEventListener('click', swallow, { capture: true, once: true })
      // 下一帧兜底：这次手势没产生 click 时摘掉监听并复位 flag，别吞下次点击
      requestAnimationFrame(() => {
        window.removeEventListener('click', swallow, { capture: true })
        bandJustEnded = false
      })
    } else {
      emptyClickOk = true
      requestAnimationFrame(() => (emptyClickOk = false))
    }
    bandStart = null
    band = null
  }

  async function onGlobalKeydown(e: KeyboardEvent) {
    if (outline.selectedIds.size === 0 || outline.editingId != null) return
    // 其它输入焦点（主编辑器/搜索框）时不抢键
    const ae = document.activeElement
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || (ae as HTMLElement).isContentEditable)) return
    if (e.key === 'Escape') { e.preventDefault(); clearSelection(); return }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      const roots = selectionRoots(outline.tree, outline.selectedIds)
      const hasKids = roots.some(n => childrenOf(outline.tree, n.id).length > 0)
      if (hasKids) {
        const { confirm } = await import('@tauri-apps/plugin-dialog')
        if (!await confirm(t('outline.deleteConfirm'), { title: t('outline.delete') })) return
      }
      if (deleteNodes(outline.tree, outline.selectedIds)) { clearSelection(); bump(); markDirty() }
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const changed = e.shiftKey
        ? outdentNodes(outline.tree, outline.selectedIds)
        : indentNodes(outline.tree, outline.selectedIds)
      if (changed) { bump(); markDirty() }
      return
    }
    if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
      const md = nodesToMarkdown(outline.tree, outline.selectedIds)
      if (md) {
        e.preventDefault()
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
        await writeText(md)
      }
    }
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
    setNodeContent(node, text)
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
    <button class="hbtn" title={t('outline.regenerate')} aria-label={t('outline.regenerate')} disabled={!applicable} onclick={onRegenerate}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
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
  {#if outline.externalConflict}
    <div class="conflict">{t('outline.externalChanged')}</div>
  {/if}
  {#if !applicable}
    <div class="body">
      <p class="empty">{tab == null ? t('outline.noDocument') : t('outline.notApplicable')}</p>
    </div>
  {:else}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="body" role="tree" bind:this={bodyEl} onclick={onBodyClick}
      onpointerdown={onBandDown} onpointermove={onBandMove} onpointerup={onBandUp}>
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
  {#if band}
    {@const r = bandRect(band)}
    <div class="band" style="left:{r.left}px; top:{r.top}px; width:{r.width}px; height:{r.height}px"></div>
  {/if}
</aside>

<svelte:window onkeydown={onGlobalKeydown} />

<style>
  .outline-panel {
    position: relative;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border-color, #3333);
    overflow: hidden;
    /* 整个面板永久禁用原生文字选区/拖字——多选由大纲交互自己处理；
       编辑态 textarea 与搜索框内例外 */
    user-select: none;
    -webkit-user-select: none;
  }
  .outline-panel :global(textarea), .outline-panel :global(input) {
    user-select: text;
    -webkit-user-select: text;
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
  .conflict {
    background: var(--warn-bg, #fef08a); color: var(--warn-fg, #78350f);
    font-size: 11px; padding: 4px 8px; border-bottom: 1px solid var(--border-color, #3333);
  }
  .body { flex: 1; overflow-y: auto; padding: 8px; font-family: var(--outline-font-family); }
  /* 低调的中性框选矩形（Finder 风格），跟随主题前景色 */
  .band {
    position: fixed; z-index: 30; pointer-events: none;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    background: color-mix(in srgb, currentColor 6%, transparent);
    border-radius: 2px;
  }
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
