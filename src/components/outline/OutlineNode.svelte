<script lang="ts">
  import OutlineNode from './OutlineNode.svelte'
  import InlineRender from './InlineRender.svelte'
  import { outline, bump, markDirty } from '../../lib/outline/store.svelte'
  import { childrenOf, type OutlineNode as NodeT } from '../../lib/outline/model'
  import {
    createSiblingBelow, createSiblingAbove, mergeWithPrevious,
    indentNode, outdentNode, moveNodeUp, moveNodeDown, applyInlineWrap,
  } from '../../lib/outline/commands'
  import { visibleNodes } from '../../lib/outline/model'
  import { matchCommand, type OutlineCommandId } from '../../lib/outline/shortcuts'

  let {
    node, depth, resolved, onJump, onPageClick, onEditorInput, onContextMenu, onDragOp,
    visibleIds = null,
  }: {
    node: NodeT
    depth: number
    resolved: Record<OutlineCommandId, string>
    onJump: (n: NodeT) => void
    onPageClick: (target: string) => void
    /** 编辑态每次 input：内容、光标、textarea 元素（菜单锚定用，Task 13） */
    onEditorInput: (node: NodeT, value: string, cursor: number, el: HTMLTextAreaElement, e?: KeyboardEvent) => boolean
    onContextMenu: (e: MouseEvent, n: NodeT) => void
    onDragOp: (drag: string, target: string, mode: 'sibling' | 'child') => void
    /** 搜索过滤：非 null 时仅渲染集合内的子节点（保住匹配节点的祖先路径），并无视折叠展开命中项 */
    visibleIds?: Set<string> | null
  } = $props()

  let kids = $derived.by(() => {
    void outline.version
    const all = childrenOf(outline.tree, node.id)
    return visibleIds ? all.filter((k) => visibleIds.has(k.id)) : all
  })
  let editing = $derived(outline.editingId === node.id)
  let textareaEl: HTMLTextAreaElement | undefined = $state()

  $effect(() => { if (editing && textareaEl) textareaEl.focus() })

  function startEdit() {
    outline.editingId = node.id
  }
  function commitEdit(value: string) {
    if (node.source !== 'manual') { outline.editingId = null; return }  // auto is read-only
    node.content = value
    outline.editingId = null
    bump(); markDirty()
  }
  function onBulletClick() {
    if (node.anchorLine != null) onJump(node)
  }

  function focusNode(id: string | null) {
    outline.editingId = id
  }

  function onKeydown(e: KeyboardEvent) {
    const el = e.currentTarget as HTMLTextAreaElement
    // 先给菜单层机会（/ 与 [[ 菜单打开时接管 ↑↓/Enter/Esc）
    if (onEditorInput(node, el.value, el.selectionStart, el, e)) { e.preventDefault(); return }

    const atStart = el.selectionStart === 0 && el.selectionEnd === 0
    const atEnd = el.selectionStart === el.value.length

    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      if (node.source !== 'manual') {
        // read-only: Enter spawns an editable manual sibling directly below
        const id = createSiblingBelow(outline.tree, node.id)
        bump(); markDirty(); focusNode(id)
        return
      }
      node.content = el.value
      // 行首 Enter → 上方建兄弟（render.cljs handle-key-down 语义）
      const id = atStart && el.value.length > 0
        ? createSiblingAbove(outline.tree, node.id)
        : createSiblingBelow(outline.tree, node.id)
      bump(); markDirty(); focusNode(id)
      return
    }
    if (e.key === 'Backspace' && atStart) {
      const res = mergeWithPrevious(outline.tree, node.id)
      if (res) { e.preventDefault(); bump(); markDirty(); focusNode(res.mergedInto) }
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.metaKey && !e.altKey) {
      const vis = visibleNodes(outline.tree)
      const idx = vis.findIndex(n => n.id === node.id)
      const nb = e.key === 'ArrowUp' ? (atStart ? vis[idx - 1] : null) : (atEnd ? vis[idx + 1] : null)
      if (nb) {
        e.preventDefault()
        node.content = el.value
        bump(); markDirty()
        focusNode(nb.source === 'manual' ? nb.id : null)
      }
      return
    }
    const cmd = matchCommand(e, resolved)
    if (!cmd) return
    e.preventDefault()
    node.content = el.value
    if (cmd === 'outline.indent') indentNode(outline.tree, node.id)
    else if (cmd === 'outline.outdent') outdentNode(outline.tree, node.id)
    else if (cmd === 'outline.toggleCollapse') node.collapsed = !node.collapsed
    else if (cmd === 'outline.moveUp') moveNodeUp(outline.tree, node.id)
    else if (cmd === 'outline.moveDown') moveNodeDown(outline.tree, node.id)
    else if (cmd === 'outline.bold' || cmd === 'outline.italic') {
      const r = applyInlineWrap(el.value, el.selectionStart, el.selectionEnd, cmd === 'outline.bold' ? '**' : '__')
      el.value = r.text
      el.setSelectionRange(r.selStart, r.selEnd)
      node.content = r.text
    }
    bump(); markDirty()
  }

  // 拖拽（render.cljs:733 detect-drop-mode：落点 X 在文本左缘右侧 → child）
  let dropMode: 'sibling' | 'child' | null = $state(null)
  function onDragStart(e: DragEvent) {
    if (node.source !== 'manual') { e.preventDefault(); return }
    e.dataTransfer?.setData('text/outline-node', node.id)
  }
  function onDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes('text/outline-node')) return
    e.preventDefault()
    const row = e.currentTarget as HTMLElement
    const contentEl = row.querySelector('.content')
    const textLeft = contentEl?.getBoundingClientRect().left ?? 0
    dropMode = e.clientX >= textLeft ? 'child' : 'sibling'
  }
  function onDrop(e: DragEvent) {
    const dragId = e.dataTransfer?.getData('text/outline-node')
    if (dragId && dropMode) onDragOp(dragId, node.id, dropMode)
    dropMode = null
  }
</script>

<div class="node" style="--depth: {depth}">
  <div
    class="row"
    class:auto={node.source !== 'manual'}
    class:drop-sibling={dropMode === 'sibling'}
    class:drop-child={dropMode === 'child'}
    role="treeitem"
    aria-selected={editing}
    ondragover={onDragOver}
    ondragleave={() => (dropMode = null)}
    ondrop={onDrop}
    oncontextmenu={(e) => { e.preventDefault(); onContextMenu(e, node) }}
  >
    {#if kids.length > 0}
      <button class="tri" class:closed={node.collapsed}
        onclick={() => { node.collapsed = !node.collapsed; bump(); markDirty() }}>▾</button>
    {:else}<span class="tri-spacer"></span>{/if}
    <span
      class="bullet"
      class:src-toc={node.source === 'toc'}
      class:src-hl={node.source === 'highlight'}
      draggable={node.source === 'manual'}
      ondragstart={onDragStart}
      onclick={onBulletClick}
    >•</span>
    {#if editing}
      <textarea
        bind:this={textareaEl}
        class="content edit"
        class:hl={node.source === 'highlight'}
        rows="1"
        readonly={node.source !== 'manual'}
        value={node.content}
        onblur={(e) => commitEdit((e.currentTarget as HTMLTextAreaElement).value)}
        onkeydown={onKeydown}
        oninput={(e) => {
          const el = e.currentTarget as HTMLTextAreaElement
          el.style.height = 'auto'
          el.style.height = el.scrollHeight + 'px'
          onEditorInput(node, el.value, el.selectionStart, el)
        }}
      ></textarea>
    {:else}
      <span class="content" class:hl={node.source === 'highlight'} onclick={startEdit} role="button" tabindex="0"
        onkeydown={(e) => { if (e.key === 'Enter') startEdit() }}>
        <InlineRender content={node.content} onPageClick={onPageClick} />
      </span>
    {/if}
  </div>
  {#if visibleIds ? kids.length > 0 : !node.collapsed}
    {#each kids as child (child.id)}
      <OutlineNode node={child} depth={depth + 1} {resolved} {onJump} {onPageClick} {onEditorInput} {onContextMenu} {onDragOp} {visibleIds} />
    {/each}
  {/if}
</div>

<style>
  .node { margin-left: calc(var(--depth) * 0px); }
  .row {
    display: flex; align-items: flex-start; gap: 4px;
    padding: 1px 4px 1px calc(var(--depth) * 16px + 4px);
    border-radius: 4px;
    font-family: var(--outline-font-family);
    font-size: var(--outline-font-size, 13px);
    line-height: var(--outline-line-height, 1.5);
  }
  .row:hover { background: var(--hover-bg, #8881); }
  .row.drop-sibling { box-shadow: 0 2px 0 var(--accent-color, #4a80d4); }
  .row.drop-child { box-shadow: inset 2px 0 0 var(--accent-color, #4a80d4); background: #4a80d411; }
  .row.auto .content { opacity: 0.92; }
  .tri { background: none; border: none; padding: 0; width: 14px; cursor: pointer; font-size: 10px; opacity: 0.6; transition: transform 0.1s; }
  .tri.closed { transform: rotate(-90deg); }
  .tri-spacer { width: 14px; flex-shrink: 0; }
  .bullet { cursor: pointer; opacity: 0.7; }
  .bullet.src-toc { color: var(--accent-color, #4a80d4); }
  .bullet.src-hl { color: #d4a94a; }
  .content { flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; cursor: text; }
  .content.hl,
  textarea.hl { background: var(--highlight-bg, #fde68a); border-radius: 2px; }
  textarea.edit {
    resize: none; overflow: hidden; border: none; outline: 1px solid var(--accent-color, #4a80d4);
    border-radius: 3px; background: transparent; color: inherit; font: inherit; padding: 0 2px;
  }
</style>
