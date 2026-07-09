// src/lib/outline/markdown.ts
import { createTree, addNode, childrenOf, newId, type OutlineTree, type OutlineNode, type NodeSource } from './model'

const PROP_RE = /^(type|line|id|collapsed):: (.*)$/

/** OutlineTree optionally annotated with ids that must be written back. */
interface AnnotatedTree extends OutlineTree {
  _persistIds?: Set<string>
}

/**
 * Serialize the tree to companion-file markdown.
 * `persistIds`: node ids that must be written (manual block-ref targets).
 * When `tree` was produced by `parseOutline`, explicitly-parsed ids are
 * already tracked on `tree._persistIds` and are merged automatically.
 */
export function serializeOutline(tree: OutlineTree, persistIds: Set<string> = new Set()): string {
  const atree = tree as AnnotatedTree
  const effectivePersistIds: Set<string> = atree._persistIds
    ? new Set([...atree._persistIds, ...persistIds])
    : persistIds

  const lines: string[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const n of childrenOf(tree, parentId)) {
      const indent = '  '.repeat(depth)
      const contentLines = n.content.split('\n')
      lines.push(`${indent}- ${contentLines[0]}`)
      for (const cont of contentLines.slice(1)) lines.push(`${indent}  ${cont}`)
      if (n.source !== 'manual') {
        lines.push(`${indent}  type:: ${n.source}`)
        if (n.anchorLine != null) lines.push(`${indent}  line:: ${n.anchorLine}`)
      }
      if (effectivePersistIds.has(n.id)) {
        lines.push(`${indent}  id:: ${n.id}`)
      }
      if (n.collapsed) lines.push(`${indent}  collapsed:: true`)
      walk(n.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines.length ? lines.join('\n') + '\n' : ''
}

export function parseOutline(text: string): OutlineTree {
  const tree = createTree() as AnnotatedTree
  tree._persistIds = new Set()

  // 每层的"当前节点"栈：stack[d] = 深度 d 的最近节点
  const stack: OutlineNode[] = []
  let current: OutlineNode | null = null
  let currentDepth = -1
  let orderCounters: number[] = []

  const nextOrder = (depth: number): number => {
    orderCounters.length = depth + 1
    orderCounters[depth] = (orderCounters[depth] ?? -100) + 100
    return orderCounters[depth]
  }

  const push = (depth: number, content: string): OutlineNode => {
    const parent = depth > 0 ? stack[depth - 1] ?? null : null
    const node: OutlineNode = {
      id: newId(),
      parentId: parent ? parent.id : null,
      order: nextOrder(depth),
      content,
      collapsed: false,
      source: 'manual',
    }
    addNode(tree, node)
    stack.length = depth
    stack[depth] = node
    current = node
    currentDepth = depth
    return node
  }

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue
    const bullet = raw.match(/^((?:  )*)- (.*)$/)
    if (bullet) {
      push(bullet[1].length / 2, bullet[2])
      continue
    }
    if (current) {
      // 续行或属性行：期望缩进 = 节点缩进 + 2
      const contIndent = '  '.repeat(currentDepth) + '  '
      if (raw.startsWith(contIndent)) {
        const body = raw.slice(contIndent.length)
        const prop = body.match(PROP_RE)
        if (prop) {
          const [, key, value] = prop
          if (key === 'type' && (value === 'toc' || value === 'highlight')) current.source = value as NodeSource
          else if (key === 'line') current.anchorLine = parseInt(value, 10)
          else if (key === 'collapsed') current.collapsed = value === 'true'
          else if (key === 'id') {
            // 重键：换 id 需迁移 map 与子引用（此时尚无子节点，直接迁移 map）
            tree.nodes.delete(current.id)
            current.id = value
            tree.nodes.set(value, current)
            for (const n of tree.nodes.values()) if (n.parentId && !tree.nodes.has(n.parentId)) n.parentId = current.id
            // Mark this id as explicitly set so it gets written back
            tree._persistIds!.add(value)
          }
        } else {
          current.content += '\n' + body
        }
        continue
      }
    }
    // 无法归类的行：降级为根层手写节点（spec: 不丢内容）
    push(0, raw.trim())
  }
  return tree
}
