// src/lib/outline/markdown.ts — copied from host src/lib/outline/markdown.ts
// (only serializeOutline is used by convert; kept faithful for future reuse).
import { childrenOf, type OutlineTree } from './model'

/**
 * Serialize the tree to companion-file markdown.
 * `persistIds`: node ids that must be written (manual block-ref targets).
 * Nodes with `persistId === true` (set by parseOutline when `id::` was
 * explicitly present) are always written regardless of `persistIds`.
 */
export function serializeOutline(tree: OutlineTree, persistIds: Set<string> = new Set()): string {
  const lines: string[] = []
  if (tree.frontmatter != null) lines.push('---', tree.frontmatter, '---')
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
      if (n.createdAt) lines.push(`${indent}  created:: ${n.createdAt}`)
      if (n.updatedAt) lines.push(`${indent}  updated:: ${n.updatedAt}`)
      if (n.persistId === true || persistIds.has(n.id)) {
        lines.push(`${indent}  id:: ${n.id}`)
      }
      if (n.collapsed) lines.push(`${indent}  collapsed:: true`)
      walk(n.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines.length ? lines.join('\n') + '\n' : ''
}
