// src/lib/outline/sync.ts
import { childrenOf, newId, nowIso, setNodeContent, calculateOrderBetween, type OutlineTree, type OutlineNode } from './model'
import type { AutoItem } from './derive'

const keyOf = (source: string, content: string) => source + ' ' + content

/** 树中 auto 节点按先序遍历（= 派生序）拍平 */
function autoSequence(tree: OutlineTree): OutlineNode[] {
  const out: OutlineNode[] = []
  const walk = (pid: string | null) => {
    for (const n of childrenOf(tree, pid)) {
      if (n.source !== 'manual') out.push(n)
      walk(n.id)
    }
  }
  walk(null)
  return out
}

/** 经典 LCS，返回 [oldIdx, newIdx] 配对 */
function lcsPairs(oldKeys: string[], newKeys: string[]): Array<[number, number]> {
  const m = oldKeys.length, n = newKeys.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = oldKeys[i] === newKeys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs: Array<[number, number]> = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (oldKeys[i] === newKeys[j]) { pairs.push([i, j]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return pairs
}

/** 孤儿手写子树重挂：沿被删父链向上找第一个仍存活的节点 */
function reparentOrphans(tree: OutlineTree, removedParents: Map<string, string | null>): void {
  const resolve = (pid: string | null): string | null => {
    while (pid != null && !tree.nodes.has(pid)) pid = removedParents.get(pid) ?? null
    return pid
  }
  for (const n of tree.nodes.values()) {
    if (n.parentId != null && !tree.nodes.has(n.parentId)) n.parentId = resolve(n.parentId)
  }
}

export function syncAutoItems(tree: OutlineTree, items: AutoItem[]): void {
  const oldSeq = autoSequence(tree)
  const pairs = lcsPairs(oldSeq.map(n => keyOf(n.source, n.content)), items.map(it => keyOf(it.source, it.content)))
  const matchedOld = new Map<number, number>(pairs)
  const matchedNew = new Map<number, OutlineNode>(pairs.map(([o, nw]) => [nw, oldSeq[o]]))

  // 1) 删除未匹配的旧 auto（记录父链供重挂）
  const removedParents = new Map<string, string | null>()
  oldSeq.forEach((node, idx) => {
    if (!matchedOld.has(idx)) { removedParents.set(node.id, node.parentId); tree.nodes.delete(node.id) }
  })

  // 2) 按新序列重建 auto 结构
  const parentStack: OutlineNode[] = []
  const autoOrderCounter = new Map<string | null, number>()
  const nextAutoOrder = (pid: string | null): number => {
    const v = (autoOrderCounter.get(pid) ?? -100) + 100
    autoOrderCounter.set(pid, v)
    return v
  }

  items.forEach((it, idx) => {
    parentStack.length = it.depth
    const parent = it.depth > 0 ? parentStack[it.depth - 1] ?? null : null
    const pid = parent ? parent.id : null
    let node = matchedNew.get(idx)
    if (node) {
      setNodeContent(node, it.content)
      node.anchorLine = it.anchorLine
      node.parentId = pid
      node.order = nextAutoOrder(pid)
    } else {
      node = {
        id: newId(), parentId: pid, order: nextAutoOrder(pid),
        content: it.content, collapsed: false, source: it.source, anchorLine: it.anchorLine,
        ...(it.source === 'highlight' ? { createdAt: nowIso() } : {}),
      }
      tree.nodes.set(node.id, node)
    }
    if (it.source === 'toc') parentStack[it.depth] = node
  })

  // 3) 孤儿手写子树重挂
  reparentOrphans(tree, removedParents)

  // 4) 手写兄弟排到同级 auto 之后，保持相对序
  for (const pid of new Set([...tree.nodes.values()].map(n => n.parentId))) {
    const siblings = childrenOf(tree, pid)
    const lastAuto = siblings.filter(n => n.source !== 'manual').pop()
    let prev = lastAuto ? lastAuto.order : null
    for (const mnode of siblings.filter(n => n.source === 'manual')) {
      mnode.order = calculateOrderBetween(prev, null)
      prev = mnode.order
    }
  }
}

/** 强制全量重建 auto（绕过 diff 保 id），手写节点保留并重挂 */
export function regenerate(tree: OutlineTree, items: AutoItem[]): void {
  const removedParents = new Map<string, string | null>()
  for (const n of [...tree.nodes.values()]) {
    if (n.source !== 'manual') { removedParents.set(n.id, n.parentId); tree.nodes.delete(n.id) }
  }
  reparentOrphans(tree, removedParents)
  syncAutoItems(tree, items)
}
