// src/lib/outline/store.svelte.ts
import { createTree, childrenOf, type OutlineTree } from './model'
import { serializeOutline, parseOutline } from './markdown'
import { deriveAutoItems } from './derive'
import { syncAutoItems, regenerate as regenerateTree } from './sync'
import { parseInline } from './parser'
import type { BacklinkIndex } from './backlinks'
import { pageNameOf } from './backlinks'
import { touchFrontmatter, fmHas } from './frontmatter'

export interface OutlineState {
  /** 全屏大纲 tab 模式:当前挂载的 .note.md 路径 */
  docPath: string | null
  tree: OutlineTree
  /** 触发 Svelte 重渲染的版本号：任何树结构/内容变更后 bump */
  version: number
  editingId: string | null
  /** 多选集合。每次变更必须整体重赋值（Set 内部变异不触发响应） */
  selectedIds: Set<string>
  /** Shift 连选的锚点：最近一次点击/进入编辑的节点 */
  selectionAnchor: string | null
  backlinkIndex: BacklinkIndex | null
}

export const outline = $state<OutlineState>({
  docPath: null,
  tree: createTree(),
  version: 0,
  editingId: null,
  selectedIds: new Set(),
  selectionAnchor: null,
  backlinkIndex: null,
})

export function bump(): void { outline.version++ }

export function setSelection(ids: Iterable<string>): void {
  outline.selectedIds = new Set(ids)
}

export function clearSelection(): void {
  if (outline.selectedIds.size > 0) outline.selectedIds = new Set()
}

/** 新旧两种大纲后缀(迁移期兼容识别) */
export const OUTLINE_SUFFIX_RE = /\.notes?\.md$/i

export function companionPathFor(mainPath: string): string | null {
  if (OUTLINE_SUFFIX_RE.test(mainPath)) return null
  const m = mainPath.match(/^(.*)\.(md|markdown|mdown|mkd)$/i)
  return m ? `${m[1]}.note.md` : null
}

/** 需要写 id:: 的节点：被 ((ref)) 引用的 + 带手写子节点的 auto 节点 */
export function persistIdsFor(tree: OutlineTree): Set<string> {
  const ids = new Set<string>()
  for (const n of tree.nodes.values()) {
    for (const seg of parseInline(n.content)) {
      if (seg.t === 'block-ref' && tree.nodes.has(seg.refId)) ids.add(seg.refId)
    }
    if (n.source !== 'manual' && childrenOf(tree, n.id).some(c => c.source === 'manual')) ids.add(n.id)
  }
  return ids
}

/** True when the tree carries no meaningful outline: no auto nodes and every
 *  manual node is blank. Used to skip writing a phantom `.note.md`. */
export function isEffectivelyEmpty(tree: OutlineTree): boolean {
  for (const n of tree.nodes.values()) {
    if (n.source !== 'manual') return false
    if (n.content.trim() !== '') return false
  }
  return true
}

/** copy-ref 时固定写入 id 的集合：确保即使引用被粘到别的文件，本文件也会落盘 id:: */
export const pinnedIds = new Set<string>()

// ---------- 全屏大纲 tab 模式(phase 2):IO 由 tabs 体系接管,这里只有内存树 ----------

let changeSink: (() => void) | null = null
/** 编辑器注册:任何树变更(markDirty)后被调用,负责 serializeDoc → setContent(tab) */
export function setChangeSink(fn: (() => void) | null): void { changeSink = fn }

/**
 * 挂载一篇 .note.md 文本到全局树。mainContent 非 null(伴生笔记)时对主文档
 * 跑一次派生同步(spec §4:派生移到大纲 tab 挂载时)。不写盘、不触发 sink。
 */
export async function attachDoc(docPath: string, text: string, mainContent: string | null): Promise<void> {
  outline.docPath = docPath
  outline.tree = parseOutline(text)
  outline.editingId = null
  outline.selectedIds = new Set()
  outline.selectionAnchor = null
  // 存量文件缺 created → 补文件 birthtime(测试环境 stat 不可用,静默跳过)
  if (!fmHas(outline.tree.frontmatter, 'created')) {
    const info = await import('@tauri-apps/plugin-fs')
      .then(m => m.stat(docPath)).catch(() => null)
    if (outline.docPath !== docPath) return   // superseded by a later attachDoc
    if (info?.birthtime) {
      outline.tree.frontmatter = touchFrontmatter(outline.tree.frontmatter, {
        title: pageNameOf(docPath), created: new Date(info.birthtime).toISOString(),
      })
    }
  }
  if (mainContent != null) syncAutoItems(outline.tree, deriveAutoItems(mainContent))
  bump()
}

/**
 * 序列化当前树。touch=true(默认,编辑 sink 路径)刷新 front-matter 的
 * updated 并补齐 title;touch=false 用于挂载时的无副作用对比,避免
 * "打开即脏"(updated 刷新会让未编辑的 tab 变 dirty)。
 * 注:setContent 只是赋值 tab.currentContent,不会回调 markDirty,无再入循环。
 */
export function serializeDoc(touch = true): string {
  if (outline.docPath && touch) {
    outline.tree.frontmatter = touchFrontmatter(outline.tree.frontmatter, {
      title: pageNameOf(outline.docPath),
    })
  }
  return serializeOutline(outline.tree, new Set([...persistIdsFor(outline.tree), ...pinnedIds]))
}

/** 卸载当前文档:清 docPath/树/选区。全屏大纲 tab 关闭时由编辑器调用。 */
export function detach(): void {
  outline.docPath = null
  outline.tree = createTree()
  outline.editingId = null
  outline.selectedIds = new Set()
  outline.selectionAnchor = null
  bump()
}

export function regenerate(mainContent: string): void {
  regenerateTree(outline.tree, deriveAutoItems(mainContent))
  bump()
  markDirty()
}

/** 任何树变更后调用:通知编辑器 sink 序列化 → setContent(tab)。tab 模式外为 no-op。 */
export function markDirty(): void {
  changeSink?.()
}
