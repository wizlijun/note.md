<script lang="ts">
  import type { RecallTreeNode } from '../../lib/outline/recall'
  import InlineRender from './InlineRender.svelte'
  import RefTreeNode from './RefTreeNode.svelte'

  // Collapsible renderer for one recalled subtree node. When `editable`, the
  // text can be edited in place (Phase B / B1): commit writes back to source.
  let {
    node,
    defaultCollapsed = false,
    editable = false,
    onCommit,
  }: {
    node: RecallTreeNode
    defaultCollapsed?: boolean
    editable?: boolean
    onCommit?: (path: number[], oldText: string, newText: string) => void | Promise<unknown>
  } = $props()

  let collapsed = $state(defaultCollapsed)
  const hasChildren = $derived(node.children.length > 0)

  let editing = $state(false)
  let draft = $state('')

  function startEdit() {
    if (!editable) return
    draft = node.text
    editing = true
  }
  function commit() {
    if (!editing) return
    editing = false
    if (draft !== node.text) void onCommit?.(node.path, node.text, draft)
  }
  function onKeydown(e: KeyboardEvent) {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); editing = false }
  }
  function autofocusGrow(el: HTMLTextAreaElement) {
    const grow = () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
    el.focus(); el.setSelectionRange(el.value.length, el.value.length); grow()
    el.addEventListener('input', grow)
    return { destroy() { el.removeEventListener('input', grow) } }
  }
</script>

<div class="ref-node">
  <div class="ref-row">
    {#if hasChildren}
      <button class="twist" onclick={() => (collapsed = !collapsed)} aria-label="toggle">{collapsed ? '▸' : '▾'}</button>
    {:else}
      <span class="dot">•</span>
    {/if}
    {#if editing}
      <textarea class="edit" rows="1" bind:value={draft} onkeydown={onKeydown} onblur={commit} use:autofocusGrow></textarea>
    {:else}
      <!-- svelte-ignore a11y_no_static_element_interactions a11y_no_noninteractive_tabindex -->
      <span
        class="text" class:editable
        role={editable ? 'button' : undefined}
        tabindex={editable ? 0 : undefined}
        onclick={startEdit}
        onkeydown={(e) => { if (editable && e.key === 'Enter') { e.preventDefault(); startEdit() } }}
      ><InlineRender content={node.text} /></span>
    {/if}
  </div>
  {#if hasChildren && !collapsed}
    <div class="children">
      {#each node.children as c, i (i)}
        <RefTreeNode node={c} {editable} {onCommit} />
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Inherit the main outline's typography so references read as one outline. */
  .ref-row {
    display: flex; align-items: baseline; gap: 4px; padding: 1px 0;
    font-family: var(--outline-font-family);
    font-size: var(--outline-font-size, 13px);
    line-height: var(--outline-line-height, 1.5);
  }
  .twist {
    background: none; border: none; cursor: pointer; color: inherit;
    font-size: 0.7em; opacity: 0.55; width: 1.1em; flex: none; padding: 0; line-height: inherit;
  }
  .twist:hover { opacity: 1; }
  .dot { opacity: 0.35; width: 1.1em; flex: none; text-align: center; font-size: 0.7em; }
  .text { flex: 1; min-width: 0; }
  .text.editable { cursor: text; border-radius: 3px; }
  .text.editable:hover { background: var(--hover-bg, #8881); }
  /* Match the main outline's edit textarea (textarea.edit + .content). */
  .edit {
    flex: 1; min-width: 0; resize: none; overflow: hidden;
    border: none; outline: none; border-radius: 3px;
    background: transparent; color: inherit; font: inherit; padding: 0; margin: 0;
    white-space: pre-wrap; word-break: break-word;
    line-height: var(--outline-line-height, 1.5);
  }
  .children { padding-left: 1.1em; }
</style>
