// src/lib/outline/model.ts
export type NodeSource = 'toc' | 'highlight' | 'wikilink' | 'manual'

export interface OutlineNode {
  id: string
  parentId: string | null // null = 根层
  order: number           // 同级分数排序（hulunote same-deep-order）
  content: string
  collapsed: boolean
  source: NodeSource
  anchorLine?: number     // auto 节点：主文档 1-based 行号
  /** id:: was explicitly present in the companion file (or must be written); survives node copies */
  persistId?: boolean
  /** ISO 8601 创建时间；仅 highlight/manual 节点记录，toc 不记 */
  createdAt?: string
  /** ISO 8601 最近内容修改时间；仅 highlight/manual 节点记录 */
  updatedAt?: string
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** 统一的内容修改入口：内容变化且非 toc 节点时刷新 updatedAt */
export function setNodeContent(node: OutlineNode, content: string): void {
  if (node.content === content) return
  node.content = content
  if (node.source !== 'toc') node.updatedAt = nowIso()
}

export interface OutlineTree { nodes: Map<string, OutlineNode> }

export function createTree(): OutlineTree { return { nodes: new Map() } }

export function addNode(tree: OutlineTree, node: OutlineNode): void {
  tree.nodes.set(node.id, node)
}

export function childrenOf(tree: OutlineTree, parentId: string | null): OutlineNode[] {
  const out: OutlineNode[] = []
  for (const n of tree.nodes.values()) if (n.parentId === parentId) out.push(n)
  return out.sort((a, b) => a.order - b.order)
}

/** hulunote render.cljs:612 calculate-order-between */
export function calculateOrderBetween(prev: number | null, next: number | null): number {
  if (prev != null && next != null) return (prev + next) / 2
  if (prev != null) return prev + 100
  if (next != null) return next / 2
  return 0
}

/** hulunote render.cljs:591 normalize-sibling-orders! — idx*100 */
export function normalizeSiblingOrders(tree: OutlineTree, parentId: string | null): void {
  childrenOf(tree, parentId).forEach((n, idx) => { n.order = idx * 100 })
}

/** hulunote render.cljs:639 collect-descendant-ids */
export function collectDescendantIds(tree: OutlineTree, id: string): Set<string> {
  const acc = new Set<string>()
  const walk = (pid: string) => {
    for (const c of childrenOf(tree, pid)) { acc.add(c.id); walk(c.id) }
  }
  walk(id)
  return acc
}

/** hulunote render.cljs:663 valid-drop-target? */
export function isValidDropTarget(tree: OutlineTree, dragId: string, targetId: string): boolean {
  return !!dragId && !!targetId && dragId !== targetId
    && !collectDescendantIds(tree, dragId).has(targetId)
}

/** hulunote render.cljs:748 collect-visible-navs — 折叠节点不展开其子树 */
export function visibleNodes(tree: OutlineTree): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (pid: string | null) => {
    for (const n of childrenOf(tree, pid)) {
      out.push(n)
      if (!n.collapsed) walk(n.id)
    }
  }
  walk(null)
  return out
}

export function removeSubtree(tree: OutlineTree, id: string): void {
  for (const d of collectDescendantIds(tree, id)) tree.nodes.delete(d)
  tree.nodes.delete(id)
}

export function newId(): string {
  return crypto.randomUUID()
}
