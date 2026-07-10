// src/lib/outline/commands.ts
import {
  childrenOf, calculateOrderBetween, normalizeSiblingOrders, newId, nowIso, setNodeContent,
  visibleNodes, removeSubtree, collectDescendantIds, isValidDropTarget,
  type OutlineTree, type OutlineNode,
} from './model'

const isManual = (n: OutlineNode | undefined): n is OutlineNode => !!n && n.source === 'manual'

function siblingIndex(tree: OutlineTree, node: OutlineNode): { siblings: OutlineNode[]; idx: number } {
  const siblings = childrenOf(tree, node.parentId)
  return { siblings, idx: siblings.findIndex(s => s.id === node.id) }
}

/** render.cljs:806 create-sibling-nav! — normalize 后取中点 */
export function createSiblingBelow(tree: OutlineTree, currentId: string): string | null {
  const cur = tree.nodes.get(currentId)
  if (!cur) return null
  normalizeSiblingOrders(tree, cur.parentId)
  const { siblings, idx } = siblingIndex(tree, cur)
  const nextOrder = idx < siblings.length - 1 ? (idx + 1) * 100 : null
  const node: OutlineNode = {
    id: newId(), parentId: cur.parentId, order: calculateOrderBetween(idx * 100, nextOrder),
    content: '', collapsed: false, source: 'manual', createdAt: nowIso(),
  }
  tree.nodes.set(node.id, node)
  return node.id
}

/** render.cljs:846 create-sibling-above! — 首位时用 current-100 */
export function createSiblingAbove(tree: OutlineTree, currentId: string): string | null {
  const cur = tree.nodes.get(currentId)
  if (!cur) return null
  normalizeSiblingOrders(tree, cur.parentId)
  const { idx } = siblingIndex(tree, cur)
  const order = idx > 0 ? calculateOrderBetween((idx - 1) * 100, idx * 100) : idx * 100 - 100
  const node: OutlineNode = {
    id: newId(), parentId: cur.parentId, order,
    content: '', collapsed: false, source: 'manual', createdAt: nowIso(),
  }
  tree.nodes.set(node.id, node)
  return node.id
}

/** render.cljs:918 indent-nav! — 成为前兄弟的最后一个子节点 */
export function indentNode(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return false
  const { siblings, idx } = siblingIndex(tree, node)
  if (idx <= 0) return false
  const newParent = siblings[idx - 1]
  const lastChild = childrenOf(tree, newParent.id).pop()
  node.parentId = newParent.id
  node.order = calculateOrderBetween(lastChild ? lastChild.order : null, null)
  newParent.collapsed = false // render.cljs:941 确保新父展开
  return true
}

/** render.cljs:952 outdent-nav! — 成为父节点的下一个兄弟 */
export function outdentNode(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node) || node.parentId == null) return false
  const parent = tree.nodes.get(node.parentId)
  if (!parent) return false
  const { siblings: parentSibs, idx: pIdx } = siblingIndex(tree, parent)
  const next = pIdx < parentSibs.length - 1 ? parentSibs[pIdx + 1] : null
  node.parentId = parent.parentId
  node.order = calculateOrderBetween(parent.order, next ? next.order : null)
  return true
}

export function moveNodeUp(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return false
  const { siblings, idx } = siblingIndex(tree, node)
  if (idx <= 0) return false
  const prev = siblings[idx - 1]
  ;[node.order, prev.order] = [prev.order, node.order]
  return true
}

export function moveNodeDown(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return false
  const { siblings, idx } = siblingIndex(tree, node)
  if (idx < 0 || idx >= siblings.length - 1) return false
  const next = siblings[idx + 1]
  ;[node.order, next.order] = [next.order, node.order]
  return true
}

/** 行首 Backspace：并入上一可见节点尾部。返回目标节点与光标落点。 */
export function mergeWithPrevious(tree: OutlineTree, id: string): { mergedInto: string; joinAt: number } | null {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return null
  if (childrenOf(tree, id).length > 0) return null
  const vis = visibleNodes(tree)
  const idx = vis.findIndex(n => n.id === id)
  if (idx <= 0) return null
  const prev = vis[idx - 1]
  if (prev.source !== 'manual') {
    // 上一节点是 auto（只读）：仅当当前为空节点时允许删除
    if (node.content !== '') return null
    tree.nodes.delete(id)
    return { mergedInto: prev.id, joinAt: prev.content.length }
  }
  const joinAt = prev.content.length
  setNodeContent(prev, prev.content + node.content)
  tree.nodes.delete(id)
  return { mergedInto: prev.id, joinAt }
}

/** render.cljs:1003 apply-inline-wrap! — 纯文本版本，UI 层套用 selection */
export function applyInlineWrap(text: string, selStart: number, selEnd: number, marker: string):
  { text: string; selStart: number; selEnd: number } {
  const before = text.slice(0, selStart)
  const selected = text.slice(selStart, selEnd)
  const after = text.slice(selEnd)
  if (selected.length > 0) {
    return {
      text: before + marker + selected + marker + after,
      selStart: selStart + marker.length,
      selEnd: selEnd + marker.length,
    }
  }
  return {
    text: before + marker + marker + after,
    selStart: selStart + marker.length,
    selEnd: selStart + marker.length,
  }
}

/** 拖拽：render.cljs:671 move-nav-after! */
export function moveNodeAfter(tree: OutlineTree, dragId: string, targetId: string): boolean {
  const drag = tree.nodes.get(dragId)
  const target = tree.nodes.get(targetId)
  if (!isManual(drag) || !target || !isValidDropTarget(tree, dragId, targetId)) return false
  const { siblings, idx } = siblingIndex(tree, target)
  const next = idx < siblings.length - 1 ? siblings[idx + 1] : null
  drag.parentId = target.parentId
  drag.order = calculateOrderBetween(target.order, next ? next.order : null)
  return true
}

/** 拖拽：render.cljs:700 move-nav-to-child! — 成为最后一个子节点 */
export function moveNodeToChild(tree: OutlineTree, dragId: string, targetId: string): boolean {
  const drag = tree.nodes.get(dragId)
  const target = tree.nodes.get(targetId)
  if (!isManual(drag) || !target || !isValidDropTarget(tree, dragId, targetId)) return false
  const lastChild = childrenOf(tree, targetId).pop()
  drag.parentId = targetId
  drag.order = calculateOrderBetween(lastChild ? lastChild.order : null, null)
  target.collapsed = false
  return true
}

/** 删除（含子树）。auto 节点不可删（其生命周期由派生管理）。 */
export function deleteNode(tree: OutlineTree, id: string): boolean {
  const node = tree.nodes.get(id)
  if (!isManual(node)) return false
  removeSubtree(tree, id)
  return true
}

/** 子树 → markdown（hulunote single_note.cljs:189 get-all-navs-content） */
export function subtreeToMarkdown(tree: OutlineTree, id: string, depth = 0): string {
  const node = tree.nodes.get(id)
  if (!node) return ''
  const indent = '  '.repeat(depth)
  const contIndent = indent + '  '
  const lines = node.content.split('\n')
  const firstLine = `${indent}- ${lines[0]}\n`
  const restLines = lines.slice(1).map(l => `${contIndent}${l}\n`).join('')
  let out = firstLine + restLines
  for (const c of childrenOf(tree, id)) out += subtreeToMarkdown(tree, c.id, depth + 1)
  return out
}
