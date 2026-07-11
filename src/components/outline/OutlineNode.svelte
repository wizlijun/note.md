<script lang="ts">
  import OutlineNode from './OutlineNode.svelte'
  import InlineRender from './InlineRender.svelte'
  import { outline, bump, markDirty, setSelection, clearSelection } from '../../lib/outline/store.svelte'
  import { rangeBetween, selectionRoots } from '../../lib/outline/select'
  import { childrenOf, setNodeContent, type OutlineNode as NodeT } from '../../lib/outline/model'
  import { ANNOTATION_MARK } from '../../lib/outline/derive'
  import {
    createSiblingBelow, createSiblingAbove, mergeWithPrevious,
    indentNode, outdentNode, moveNodeUp, moveNodeDown, applyInlineWrap,
  } from '../../lib/outline/commands'
  import { visibleNodes } from '../../lib/outline/model'
  import { matchCommand, type OutlineCommandId } from '../../lib/outline/shortcuts'
  import { writeBackNoteEdit } from '../../lib/outline/note-writeback-io'

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
  // Route collapse state through outline.version so bump() re-renders it —
  // `node.collapsed` is a plain (non-proxied) property Svelte doesn't track.
  let isCollapsed = $derived.by(() => { void outline.version; return node.collapsed })
  let showChildren = $derived.by(() => {
    void outline.version
    return visibleIds ? kids.length > 0 : !node.collapsed
  })
  let textareaEl: HTMLTextAreaElement | undefined = $state()
  let selected = $derived(outline.selectedIds.has(node.id))
  // note 子节点可编辑（其余 auto 只读）；编辑起点内容留作回写定位的"旧批注"
  let editable = $derived(node.source === 'manual' || node.source === 'note')
  // 插入点批注的占位符号：样式如高亮（金色下划线）
  let markLike = $derived(node.source === 'annotation' && node.content === ANNOTATION_MARK)
  let noteBaseline: string | null = null

  $effect(() => {
    if (editing && node.source === 'note') noteBaseline = node.content
  })

  $effect(() => {
    if (editing && textareaEl) {
      // rows=1 只在 oninput 时自适应；进入编辑态先按内容撑开，多行内容不塌成一行
      textareaEl.style.height = 'auto'
      textareaEl.style.height = textareaEl.scrollHeight + 'px'
      textareaEl.focus()
    }
  })

  function startEdit() {
    outline.editingId = node.id
    outline.selectionAnchor = node.id
  }
  /** 普通点击=清选择进编辑；Shift+点击=锚点连选（不进编辑） */
  function onContentClick(e: MouseEvent) {
    const anchor = outline.selectionAnchor ?? outline.editingId
    if (e.shiftKey && anchor && anchor !== node.id) {
      e.preventDefault()
      outline.editingId = null
      setSelection(rangeBetween(outline.tree, anchor, node.id))
      return
    }
    // 行内刚拖选了一段文字：保留文字选区（供复制），不进入编辑
    const sel = window.getSelection()
    if (sel && !sel.isCollapsed) return
    clearSelection()
    startEdit()
  }
  function commitEdit(value: string) {
    if (node.source === 'note') {
      // 批注子节点：改动写回 .note.md 树 + 主文档的 {>>…<<}
      const old = noteBaseline ?? node.content
      outline.editingId = null
      if (value !== old) {
        setNodeContent(node, value)
        bump(); markDirty()
        void writeBackNoteEdit(node, old, value)
      }
      return
    }
    if (node.source !== 'manual') { outline.editingId = null; return }  // auto is read-only
    setNodeContent(node, value)
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
      if (node.source === 'note') {
        // 批注子节点：回车 = 提交并退出编辑
        commitEdit(el.value)
        return
      }
      if (node.source !== 'manual') {
        // read-only: Enter spawns an editable manual sibling directly below
        const id = createSiblingBelow(outline.tree, node.id)
        bump(); markDirty(); focusNode(id)
        return
      }
      setNodeContent(node, el.value)
      // 行首 Enter → 上方建兄弟（render.cljs handle-key-down 语义）
      const id = atStart && el.value.length > 0
        ? createSiblingAbove(outline.tree, node.id)
        : createSiblingBelow(outline.tree, node.id)
      bump(); markDirty(); focusNode(id)
      return
    }
    if (e.key === 'Backspace' && atStart) {
      if (node.source === 'note') return   // 批注子节点不参与合并
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
        if (node.source === 'note') commitEdit(el.value)
        else { setNodeContent(node, el.value); bump(); markDirty() }
        focusNode(nb.source === 'manual' || nb.source === 'note' ? nb.id : null)
      }
      return
    }
    const cmd = matchCommand(e, resolved)
    if (!cmd) return
    if (node.source === 'note') { e.preventDefault(); return }  // 结构命令对批注子节点无效
    e.preventDefault()
    setNodeContent(node, el.value)
    if (cmd === 'outline.indent') indentNode(outline.tree, node.id)
    else if (cmd === 'outline.outdent') outdentNode(outline.tree, node.id)
    else if (cmd === 'outline.toggleCollapse') node.collapsed = !node.collapsed
    else if (cmd === 'outline.moveUp') moveNodeUp(outline.tree, node.id)
    else if (cmd === 'outline.moveDown') moveNodeDown(outline.tree, node.id)
    else if ((cmd === 'outline.bold' || cmd === 'outline.italic') && node.source === 'manual') {
      const r = applyInlineWrap(el.value, el.selectionStart, el.selectionEnd, cmd === 'outline.bold' ? '**' : '__')
      el.value = r.text
      el.setSelectionRange(r.selStart, r.selEnd)
      setNodeContent(node, r.text)
    }
    bump(); markDirty()
  }

  // 拖拽（render.cljs:733 detect-drop-mode：落点 X 在文本左缘右侧 → child）
  let dropMode: 'sibling' | 'child' | null = $state(null)
  function onDragStart(e: DragEvent) {
    if (node.source !== 'manual') { e.preventDefault(); return }
    // 拖动选中集内的节点 = 整组移动（roots 逗号列表；接收侧 split）
    const ids = selected
      ? selectionRoots(outline.tree, outline.selectedIds).filter(n => n.source === 'manual').map(n => n.id)
      : [node.id]
    e.dataTransfer?.setData('text/outline-node', ids.join(','))
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
    class:selected
    data-node-id={node.id}
    role="treeitem"
    aria-selected={editing || selected}
    ondragover={onDragOver}
    ondragleave={() => (dropMode = null)}
    ondrop={onDrop}
    oncontextmenu={(e) => { e.preventDefault(); onContextMenu(e, node) }}
  >
    {#if kids.length > 0}
      <button class="tri" class:closed={isCollapsed}
        onclick={() => { node.collapsed = !node.collapsed; bump(); markDirty() }}>▾</button>
    {:else}<span class="tri-spacer"></span>{/if}
    <span
      class="bullet"
      class:src-toc={node.source === 'toc'}
      class:src-hl={node.source === 'highlight'}
      class:src-wl={node.source === 'wikilink'}
      class:src-anno={node.source === 'annotation'}
      class:src-note={node.source === 'note'}
      class:jumpable={node.anchorLine != null}
      draggable={node.source === 'manual'}
      ondragstart={onDragStart}
      onclick={onBulletClick}
    >•</span>
    {#if editing}
      <textarea
        bind:this={textareaEl}
        class="content edit"
        class:hl={node.source === 'highlight' || markLike}
        class:src-toc={node.source === 'toc'}
        rows="1"
        value={node.content}
        onbeforeinput={(e) => { if (!editable) e.preventDefault() }}
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
      <span class="content" class:hl={node.source === 'highlight' || markLike} class:src-toc={node.source === 'toc'} onclick={onContentClick} role="button" tabindex="0"
        onkeydown={(e) => { if (e.key === 'Enter') startEdit() }}>
        <!-- 空内容：塞零宽空格保证有行盒，鼠标可命中进入编辑 -->
        {#if node.content === ''}{'​'}{:else}<InlineRender content={node.content} onPageClick={onPageClick} />{/if}
      </span>
    {/if}
  </div>
  {#if showChildren}
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
  .row.drop-sibling { box-shadow: 0 2px 0 var(--accent-color, #4a80d4); }
  .row.drop-child { box-shadow: inset 2px 0 0 var(--accent-color, #4a80d4); background: #4a80d411; }
  /* 选中态：与原生文字选区同源（系统 Highlight 色）,无竖条无圆角 */
  .row.selected {
    background: Highlight;
    border-radius: 0;
  }
  .row.auto .content { opacity: 0.92; }
  .tri {
    background: none; border: none; padding: 0;
    width: 1.1em; font-size: 0.7em;
    line-height: var(--outline-line-height, 1.5);
    cursor: pointer; opacity: 0.6; transition: transform 0.1s;
  }
  .tri.closed { transform: rotate(-90deg); }
  .tri-spacer { width: 1.1em; flex-shrink: 0; }
  .bullet {
    font-size: 1em;
    line-height: var(--outline-line-height, 1.5);
    cursor: default; opacity: 0.7;
  }
  .bullet.jumpable { cursor: pointer; }
  .bullet.src-toc { color: var(--accent-color, #4a80d4); }
  .bullet.src-hl { color: #d4a94a; }
  .bullet.src-wl { color: #3aa99f; }
  .bullet.src-anno { color: #b8860b; }
  .bullet.src-note { color: color-mix(in srgb, #b8860b 55%, transparent); }
  .content {
    flex: 1; min-width: 0; white-space: pre-wrap; word-break: break-word; cursor: text;
    /* 面板整体 user-select:none；节点文字本身保留可选（跨行拖动由多选接管） */
    user-select: text; -webkit-user-select: text;
    /* 空内容时高度塌陷为 0，点击/文本光标落不到 span 上 → 保底一行高 */
    min-height: calc(1em * var(--outline-line-height, 1.5));
  }
  /* toc 灰色跟随主题前景色（GrayText 是系统色,不随 theme 变化） */
  .content.src-toc, textarea.src-toc { color: color-mix(in srgb, currentColor 45%, transparent); }
  .content.hl,
  textarea.hl {
    text-decoration: underline;
    text-decoration-color: var(--highlight-underline, #e0a500);
    text-decoration-thickness: 2px;
    text-underline-offset: 2px;
  }
  textarea.edit {
    resize: none; overflow: hidden; border: none; outline: none;
    border-radius: 3px; background: transparent; color: inherit; font: inherit; padding: 0;
  }
</style>
