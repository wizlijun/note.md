<script lang="ts">
  import type { Tab } from '../../lib/tabs.svelte'
  import { outlineGate, setOutlineWidth, setOutlineWidthLive } from '../../lib/outline/gate.svelte'
  import { t } from '../../lib/i18n/store.svelte'
  import OutlineNode from './OutlineNode.svelte'
  import {
    outline, attachTab, detach, scheduleSyncFromMain, regenerate,
    flushSave, bump, markDirty,
  } from '../../lib/outline/store.svelte'
  import { childrenOf, newId, calculateOrderBetween, type OutlineNode as NodeT } from '../../lib/outline/model'
  import { moveNodeAfter, moveNodeToChild } from '../../lib/outline/commands'
  import { resolveShortcuts, type OutlineCommandId } from '../../lib/outline/shortcuts'

  // TODO(Task 15): replace with real import from '../../lib/outline/reveal'
  function requestReveal(_anchorLine: number, _content: string): void {}
  // TODO(Task 16): replace with real import from '../../lib/outline/backlinks-io'
  function openPageOrCreate(_target: string): void {}

  let { tab }: { tab: Tab } = $props()

  // resolved shortcuts：Task 17 接设置覆盖；先用默认表
  let resolved = $state(resolveShortcuts({}))

  // 绑定当前 tab + 主文内容变化驱动同步
  $effect(() => {
    if (tab.filePath) void attachTab(tab.filePath, tab.currentContent)
  })
  $effect(() => {
    const content = tab.currentContent
    if (outline.mainPath === tab.filePath) scheduleSyncFromMain(content)
  })
  $effect(() => () => { void flushSave(); detach() })  // unmount 兜底保存

  let roots = $derived.by(() => { void outline.version; return childrenOf(outline.tree, null) })

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
    bump(); markDirty()
  }
  async function onRegenerate() {
    const { confirm } = await import('@tauri-apps/plugin-dialog')
    if (await confirm(t('outline.regenerateConfirm'), { title: t('outline.regenerate') })) {
      regenerate(tab.currentContent)
    }
  }
  // Task 13 填充：菜单接线；本任务先永远返回 false
  function onEditorInput(): boolean { return false }
  function onContextMenu(): void {}   // Task 14 填充

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
    <span class="title">{t('outline.title')}</span>
    <button class="hbtn" title={t('outline.regenerate')} onclick={onRegenerate}>⟳</button>
    <button class="hbtn" title={t('outline.addNote')} onclick={addRootNote}>＋</button>
  </header>
  {#if outline.externalConflict}
    <div class="conflict">{t('outline.externalChanged')}</div>
  {/if}
  <div class="body" role="tree">
    {#each roots as node (node.id)}
      <OutlineNode {node} depth={0} {resolved} {onJump} {onPageClick} {onEditorInput} {onContextMenu} {onDragOp} />
    {/each}
    {#if roots.length === 0}
      <p class="empty">{t('outline.empty')}</p>
    {/if}
  </div>
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
  .conflict {
    background: var(--warn-bg, #fef08a); color: var(--warn-fg, #78350f);
    font-size: 11px; padding: 4px 8px; border-bottom: 1px solid var(--border-color, #3333);
  }
  .body { flex: 1; overflow-y: auto; padding: 8px; }
  .empty { opacity: 0.5; font-size: 12px; }
</style>
