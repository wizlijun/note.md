// src/lib/outline/model.ts — copied verbatim from host src/lib/outline/model.ts.
export type NodeSource = 'toc' | 'highlight' | 'wikilink' | 'annotation' | 'note' | 'manual'

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

export interface OutlineTree { nodes: Map<string, OutlineNode>; frontmatter: string | null }

export function createTree(): OutlineTree { return { nodes: new Map(), frontmatter: null } }

export function addNode(tree: OutlineTree, node: OutlineNode): void {
  tree.nodes.set(node.id, node)
}

export function childrenOf(tree: OutlineTree, parentId: string | null): OutlineNode[] {
  const out: OutlineNode[] = []
  for (const n of tree.nodes.values()) if (n.parentId === parentId) out.push(n)
  return out.sort((a, b) => a.order - b.order)
}

export function newId(): string {
  return crypto.randomUUID()
}
