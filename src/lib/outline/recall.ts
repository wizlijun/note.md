// src/lib/outline/recall.ts
import { childrenOf, type OutlineTree, type OutlineNode } from './model'
import { parseInline, eachInline } from './parser'
import { parseOutline, serializeOutline } from './markdown'
import { backlinksFor, type BacklinkIndex } from './backlinks'

/** A hierarchy-aware backlink hit: the node that carries the link, with its
 *  ancestor chain (breadcrumb) and the descendant contents it folds over. */
export interface RecallNode {
  text: string
  breadcrumb: string[]
  subtree: string[]
}

/** A node in a recalled subtree (nested, for collapse/expand rendering).
 *  `path` is the child-index path from the source file's root (for write-back). */
export interface RecallTreeNode {
  text: string
  path: number[]
  children: RecallTreeNode[]
}

/** A carrier node with its ancestor breadcrumb and nested subtree. */
export interface RecallCarrier {
  breadcrumb: string[]
  node: RecallTreeNode
}

/** Does this node's content directly mention page X via [[X]] or #X? */
function carriesPage(content: string, pageLower: string): boolean {
  for (const node of eachInline(parseInline(content))) {
    if (node.t === 'page-link' && node.target.toLowerCase() === pageLower) return true
    if (node.t === 'hashtag' && node.tag.toLowerCase() === pageLower) return true
  }
  return false
}

/**
 * Hierarchy-aware recall: return the topmost outline nodes that carry `page`
 * (via [[page]] or #page). A carrier's descendants fold into its `subtree`
 * rather than becoming separate hits (§3.2 inheritance). Each hit records the
 * ancestor chain (root→parent) as `breadcrumb`.
 */
export function recallNodes(tree: OutlineTree, page: string): RecallNode[] {
  const pageLower = page.toLowerCase()
  const out: RecallNode[] = []
  const ancestors: string[] = []

  const subtreeOf = (nodeId: string): string[] => {
    const acc: string[] = []
    for (const child of childrenOf(tree, nodeId)) {
      acc.push(child.content)
      acc.push(...subtreeOf(child.id))
    }
    return acc
  }

  const walk = (parentId: string | null): void => {
    for (const node of childrenOf(tree, parentId)) {
      if (carriesPage(node.content, pageLower)) {
        out.push({ text: node.content, breadcrumb: [...ancestors], subtree: subtreeOf(node.id) })
        // topmost carrier only: do not recurse — descendants are folded above
      } else {
        ancestors.push(node.content)
        walk(node.id)
        ancestors.pop()
      }
    }
  }
  walk(null)
  return out
}

/**
 * Like {@link recallNodes} but returns each carrier's descendants as a nested
 * tree (for collapse/expand rendering in the Linked References outline).
 */
export function recallTree(tree: OutlineTree, page: string): RecallCarrier[] {
  const pageLower = page.toLowerCase()
  const out: RecallCarrier[] = []
  const ancestors: string[] = []

  const treeOf = (nodeId: string, basePath: number[]): RecallTreeNode[] =>
    childrenOf(tree, nodeId).map((child, i) => {
      const path = [...basePath, i]
      return { text: child.content, path, children: treeOf(child.id, path) }
    })

  const walk = (parentId: string | null, basePath: number[]): void => {
    childrenOf(tree, parentId).forEach((node, i) => {
      const path = [...basePath, i]
      if (carriesPage(node.content, pageLower)) {
        out.push({ breadcrumb: [...ancestors], node: { text: node.content, path, children: treeOf(node.id, path) } })
      } else {
        ancestors.push(node.content)
        walk(node.id, path)
        ancestors.pop()
      }
    })
  }
  walk(null, [])
  return out
}

/** Navigate to the node at a child-index path from root; null if out of range. */
function nodeAtPath(tree: OutlineTree, path: number[]): OutlineNode | null {
  let parentId: string | null = null
  let node: OutlineNode | null = null
  for (const idx of path) {
    node = childrenOf(tree, parentId)[idx] ?? null
    if (!node) return null
    parentId = node.id
  }
  return node
}

/**
 * Edit one node's text inside an outline-file's markdown and reserialize.
 * Returns the new markdown, or null when the edit is unsafe:
 *  - the node at `path` no longer exists, or its content ≠ `oldText`
 *    (the file changed underneath → caller shows "not synced"), or
 *  - the node is read-only (source other than manual/note).
 * Sets content directly (no updatedAt stamp) to keep the file diff minimal.
 */
export function editNodeInOutline(
  md: string,
  path: number[],
  oldText: string,
  newText: string,
): string | null {
  const tree = parseOutline(md)
  const node = nodeAtPath(tree, path)
  if (!node || node.content !== oldText) return null
  if (node.source !== 'manual' && node.source !== 'note') return null
  node.content = newText
  return serializeOutline(tree)
}

/** One file's linked references: the file it lives in + its carrier subtrees. */
export interface RecallGroup {
  file: string
  carriers: RecallCarrier[]
}

/**
 * Grouped, nested recall for the Linked References outline: one {@link RecallGroup}
 * per source file, each carrying its topmost carrier nodes as nested subtrees.
 *
 * Pure + synchronous: candidate files come from the flat index (a carrier line
 * literally contains `[[page]]`, so byTarget covers them), and their parsed
 * outline is read from `idx.fileTrees` — the index's watcher-maintained cache.
 * No disk read, no re-parse at view time (see backlinks.ts indexFileContent).
 */
export function recallGrouped(
  idx: BacklinkIndex,
  page: string,
  excludeFile?: string,
): RecallGroup[] {
  const out: RecallGroup[] = []
  for (const file of recallCandidateFiles(idx, page, excludeFile)) {
    const g = recallGroupForFile(idx, page, file)
    if (g) out.push(g)
  }
  return out
}

/**
 * The source files that link `page` (fast: a flat-index lookup, no tree walk).
 * Lets the UI show the frame + count immediately and stream groups in.
 */
export function recallCandidateFiles(
  idx: BacklinkIndex,
  page: string,
  excludeFile?: string,
): string[] {
  return [...new Set(backlinksFor(idx, page).map(h => h.file))].filter(f => f !== excludeFile)
}

/**
 * Recall one file's group from its cached tree. Returns null when the file has
 * no cached tree or contributes no carriers. Used for progressive/chunked load.
 */
export function recallGroupForFile(idx: BacklinkIndex, page: string, file: string): RecallGroup | null {
  const tree = idx.fileTrees.get(file)
  if (!tree) return null
  const carriers = recallTree(tree, page)
  return carriers.length ? { file, carriers } : null
}
