// src/lib/outline/store.svelte.ts
import { createTree, childrenOf, type OutlineTree } from './model'
import { serializeOutline, parseOutline } from './markdown'
import { deriveAutoItems } from './derive'
import { syncAutoItems, regenerate as regenerateTree } from './sync'
import { parseInline } from './parser'
import type { BacklinkIndex } from './backlinks'

export interface OutlineState {
  /** 主文件路径（当前面板绑定的 tab 文件） */
  mainPath: string | null
  companionPath: string | null
  tree: OutlineTree
  /** 触发 Svelte 重渲染的版本号：任何树结构/内容变更后 bump */
  version: number
  editingId: string | null
  /** 多选集合。每次变更必须整体重赋值（Set 内部变异不触发响应） */
  selectedIds: Set<string>
  /** Shift 连选的锚点：最近一次点击/进入编辑的节点 */
  selectionAnchor: string | null
  dirty: boolean
  /** 伴生文件被外部改且本地有未存改动 */
  externalConflict: boolean
  backlinkIndex: BacklinkIndex | null
}

export const outline = $state<OutlineState>({
  mainPath: null,
  companionPath: null,
  tree: createTree(),
  version: 0,
  editingId: null,
  selectedIds: new Set(),
  selectionAnchor: null,
  dirty: false,
  externalConflict: false,
  backlinkIndex: null,
})

export function bump(): void { outline.version++ }

export function setSelection(ids: Iterable<string>): void {
  outline.selectedIds = new Set(ids)
}

export function clearSelection(): void {
  if (outline.selectedIds.size > 0) outline.selectedIds = new Set()
}

export function companionPathFor(mainPath: string): string | null {
  if (/\.notes\.md$/i.test(mainPath)) return null
  const m = mainPath.match(/^(.*)\.(md|markdown|mdown|mkd)$/i)
  return m ? `${m[1]}.notes.md` : null
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
 *  manual node is blank. Used to skip writing a phantom `.notes.md`. */
export function isEffectivelyEmpty(tree: OutlineTree): boolean {
  for (const n of tree.nodes.values()) {
    if (n.source !== 'manual') return false
    if (n.content.trim() !== '') return false
  }
  return true
}

/** copy-ref 时固定写入 id 的集合：确保即使引用被粘到别的文件，本文件也会落盘 id:: */
export const pinnedIds = new Set<string>()

// ---------- IO 管线（组件层通过这些函数驱动；手动验证覆盖） ----------

let ourLastWrite = ''   // 识别自写事件，避免 file-watcher 回环
let attachSeq = 0       // re-entrancy token：rapid tab switches guard

export async function attachTab(mainPath: string, mainContent: string): Promise<void> {
  const companion = companionPathFor(mainPath)
  // Flush the outgoing doc before detach wipes companionPath/dirty — detach
  // alone would silently drop a pending debounced save. flushSave captures
  // path + serialized text synchronously, so no await is needed here.
  if (!companion) { void flushSave(); detach(); return }
  if (outline.mainPath === mainPath) return

  // Claim a sequence token before any await so a concurrent attachTab can't
  // race past the flush and steal the token.
  const token = ++attachSeq

  // Flush outgoing doc's pending save before resetting state, then kill any
  // pending sync timer so a stale 300ms callback can't inject the old doc's
  // auto items into the new tree.
  await flushSave()                                    // clears saveTimer internally
  if (token !== attachSeq) return
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }

  outline.mainPath = mainPath
  outline.companionPath = companion
  outline.editingId = null
  outline.selectedIds = new Set()
  outline.selectionAnchor = null
  outline.dirty = false
  outline.externalConflict = false

  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  if (token !== attachSeq) return

  if (await exists(companion).catch(() => false)) {
    if (token !== attachSeq) return
    const text = await readTextFile(companion).catch(() => null)
    if (token !== attachSeq) return
    outline.tree = text != null ? parseOutline(text) : createTree()
  } else {
    outline.tree = createTree()
  }

  // 附加后立刻对当前主文内容跑一次同步（含首开派生）
  syncAutoItems(outline.tree, deriveAutoItems(mainContent))
  bump()
}

export function detach(): void {
  // Clear pending timers; caller (panel unmount) is responsible for flushing
  // any unsaved work via flushSave() before calling detach().
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null }
  outline.mainPath = null
  outline.companionPath = null
  outline.tree = createTree()
  outline.editingId = null
  outline.selectedIds = new Set()
  outline.selectionAnchor = null
  outline.dirty = false
  bump()
}

// -- 主文变化 → debounce 300ms 同步（spec"实时同步"）
let syncTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleSyncFromMain(mainContent: string): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncAutoItems(outline.tree, deriveAutoItems(mainContent))
    bump()
    markDirty()
  }, 300)
}

export function regenerate(mainContent: string): void {
  regenerateTree(outline.tree, deriveAutoItems(mainContent))
  bump()
  markDirty()
}

// -- 树变更 → debounce 800ms 写伴生文件；关面板/换 tab 前调 flushSave()
let saveTimer: ReturnType<typeof setTimeout> | null = null
export function markDirty(): void {
  outline.dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushSave() }, 800)
}

export async function flushSave(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const path = outline.companionPath
  if (!outline.dirty || !path) return
  if (isEffectivelyEmpty(outline.tree)) { outline.dirty = false; return }  // don't write phantom companion
  const text = serializeOutline(outline.tree, new Set([...persistIdsFor(outline.tree), ...pinnedIds]))
  const { writeTextFile } = await import('@tauri-apps/plugin-fs')
  try {
    await writeTextFile(path, text)
    ourLastWrite = text   // set only after successful write to avoid masking external changes on failure
    outline.dirty = false
  } catch (e) {
    console.warn('[outline] save failed:', e)
    const { pushToast } = await import('../toast.svelte')
    pushToast({ level: 'error', message: String(e) })
  }
}

/** 伴生文件外部变更：无未存改动 → 静默重载；有 → 标记冲突条（spec"保存与错误处理"） */
export async function onCompanionExternalChange(): Promise<void> {
  if (!outline.companionPath) return
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  const text = await readTextFile(outline.companionPath).catch(() => null)
  if (text == null || text === ourLastWrite) return
  if (outline.dirty) { outline.externalConflict = true; return }
  outline.tree = parseOutline(text)
  bump()
}

export function resolveConflictKeepMine(): void {
  outline.externalConflict = false
  markDirty()
}

export async function resolveConflictReload(): Promise<void> {
  outline.externalConflict = false
  outline.dirty = false
  await onCompanionExternalChange()
}
