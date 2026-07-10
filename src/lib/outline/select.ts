// src/lib/outline/select.ts — 多节点选择的纯函数
import { visibleNodes, type OutlineTree, type OutlineNode } from './model'

/** 可见序下 a、b 之间(含端点)的节点 id;任一端不可见时返回空 */
export function rangeBetween(tree: OutlineTree, aId: string, bId: string): string[] {
  const vis = visibleNodes(tree)
  const ai = vis.findIndex(n => n.id === aId)
  const bi = vis.findIndex(n => n.id === bId)
  if (ai < 0 || bi < 0) return []
  const [lo, hi] = ai <= bi ? [ai, bi] : [bi, ai]
  return vis.slice(lo, hi + 1).map(n => n.id)
}

/** 选择集中"根":祖先均不在选择集内的节点,按可见序返回 */
export function selectionRoots(tree: OutlineTree, ids: ReadonlySet<string>): OutlineNode[] {
  const roots: OutlineNode[] = []
  for (const n of visibleNodes(tree)) {
    if (!ids.has(n.id)) continue
    let pid = n.parentId
    let covered = false
    while (pid != null) {
      if (ids.has(pid)) { covered = true; break }
      pid = tree.nodes.get(pid)?.parentId ?? null
    }
    if (!covered) roots.push(n)
  }
  return roots
}
