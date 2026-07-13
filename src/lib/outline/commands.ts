// src/lib/outline/commands.ts
import {
  childrenOf, calculateOrderBetween, normalizeSiblingOrders, newId, nowIso, setNodeContent,
  visibleNodes, removeSubtree, collectDescendantIds, isValidDropTarget,
  type OutlineTree, type OutlineNode,
} from './model'
import type { ParsedPasteNode } from './paste'

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

/**
 * 粘贴解析后的层级列表挂进大纲（spec 2026-07-13 Option A）。
 * - parsed[0] 并入当前节点：content = head + parsed[0].content
 * - parsed[1..] 按相对 depth：depth 0 = 当前节点的兄弟（紧跟其后），
 *   depth d>=1 = levelStack[d-1] 之下（追加到该父现有子末尾）
 * - tail 追加到最后一个新建节点末尾
 * 返回最后一个受影响节点 id（用于落焦点）。
 */
export function insertPastedTree(
  tree: OutlineTree,
  currentNodeId: string,
  head: string,
  tail: string,
  parsed: ParsedPasteNode[],
): string {
  const cur = tree.nodes.get(currentNodeId)
  if (!cur) return currentNodeId
  if (parsed.length === 0) { setNodeContent(cur, head + tail); return currentNodeId }

  // 单行：并入当前节点，无新节点
  if (parsed.length < 2) {
    setNodeContent(cur, head + parsed[0].content + tail)
    return currentNodeId
  }

  setNodeContent(cur, head + parsed[0].content)

  // levelStack[d] = 该 depth 最近建出的节点 id；index 0 初始为 currentNodeId, 随 d=0 兄弟推进而更新
  const levelStack: string[] = [currentNodeId]
  // 每个父节点的排序游标：{ prev: 上一个已放子节点 order, next: 固定上界 }
  const cursor = new Map<string | null, { prev: number | null; next: number | null }>()
  let lastCreated = currentNodeId

  for (let i = 1; i < parsed.length; i++) {
    const d = parsed[i].depth
    const parentId = d === 0 ? cur.parentId : levelStack[Math.min(d, levelStack.length) - 1]

    if (!cursor.has(parentId)) {
      if (d === 0) {
        // 当前节点的新兄弟：插到 cur 之后、cur 原下一个兄弟之前
        const sibs = childrenOf(tree, parentId)
        const idx = sibs.findIndex(s => s.id === cur.id)
        const nb = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null
        cursor.set(parentId, { prev: cur.order, next: nb ? nb.order : null })
      } else {
        // 更深层：追加到父现有子的末尾（父多为刚建出的空节点）
        const kids = childrenOf(tree, parentId)
        cursor.set(parentId, { prev: kids.length ? kids[kids.length - 1].order : null, next: null })
      }
    }
    const c = cursor.get(parentId)!
    const order = calculateOrderBetween(c.prev, c.next)
    const node: OutlineNode = {
      id: newId(), parentId, order,
      content: parsed[i].content, collapsed: false, source: 'manual', createdAt: nowIso(),
    }
    tree.nodes.set(node.id, node)
    c.prev = order

    // 维护 levelStack：本层记为该节点，截断更深层
    levelStack[d] = node.id
    levelStack.length = d + 1
    lastCreated = node.id
  }

  if (tail) {
    const last = tree.nodes.get(lastCreated)!
    setNodeContent(last, last.content + tail)
  }
  return lastCreated
}

// ---------- 批量操作（多节点选择,见 2026-07-10-outline-multiselect spec） ----------
import { selectionRoots } from './select'

/** 批量删除：selection roots 中的手写节点连子树删除。返回是否有改动。 */
export function deleteNodes(tree: OutlineTree, ids: ReadonlySet<string>): boolean {
  let changed = false
  for (const r of selectionRoots(tree, ids)) {
    if (r.source === 'manual') { removeSubtree(tree, r.id); changed = true }
  }
  return changed
}

/** roots 按 parentId 分组（保持可见序） */
function rootGroups(tree: OutlineTree, ids: ReadonlySet<string>): Map<string | null, OutlineNode[]> {
  const groups = new Map<string | null, OutlineNode[]>()
  for (const r of selectionRoots(tree, ids)) {
    if (r.source !== 'manual') continue
    const g = groups.get(r.parentId) ?? []
    g.push(r)
    groups.set(r.parentId, g)
  }
  return groups
}

/** 批量缩进：每个同父组整组挂到组首前一个未选中兄弟之下,保持相对顺序 */
export function indentNodes(tree: OutlineTree, ids: ReadonlySet<string>): boolean {
  let changed = false
  for (const [parentId, group] of rootGroups(tree, ids)) {
    const siblings = childrenOf(tree, parentId)
    const firstIdx = siblings.findIndex(s => s.id === group[0].id)
    // 组首之前最近的未选中兄弟作为新父
    let newParent: OutlineNode | null = null
    for (let i = firstIdx - 1; i >= 0; i--) {
      if (!ids.has(siblings[i].id)) { newParent = siblings[i]; break }
    }
    if (!newParent) continue
    let prevOrder = childrenOf(tree, newParent.id).pop()?.order ?? null
    for (const n of group) {
      n.parentId = newParent.id
      n.order = calculateOrderBetween(prevOrder, null)
      prevOrder = n.order
    }
    newParent.collapsed = false
    changed = true
  }
  return changed
}

/** 批量反缩进：逆可见序逐个 outdent,保持组内相对顺序 */
export function outdentNodes(tree: OutlineTree, ids: ReadonlySet<string>): boolean {
  let changed = false
  const roots = selectionRoots(tree, ids)
  for (let i = roots.length - 1; i >= 0; i--) {
    if (outdentNode(tree, roots[i].id)) changed = true
  }
  return changed
}

/** 批量拖拽：roots 依次落到 target 之后（组内保持相对顺序） */
export function moveNodesAfter(tree: OutlineTree, ids: ReadonlySet<string>, targetId: string): boolean {
  let changed = false
  let prev = targetId
  for (const r of selectionRoots(tree, ids)) {
    if (moveNodeAfter(tree, r.id, prev)) { prev = r.id; changed = true }
  }
  return changed
}

/** 批量拖拽为子节点：整组成为 target 的尾部子节点 */
export function moveNodesToChild(tree: OutlineTree, ids: ReadonlySet<string>, targetId: string): boolean {
  let changed = false
  for (const r of selectionRoots(tree, ids)) {
    if (moveNodeToChild(tree, r.id, targetId)) changed = true
  }
  return changed
}

/** 选中内容（含子树）→ markdown,用于批量复制 */
export function nodesToMarkdown(tree: OutlineTree, ids: ReadonlySet<string>): string {
  return selectionRoots(tree, ids).map(r => subtreeToMarkdown(tree, r.id)).join('')
}
