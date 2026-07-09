// src/lib/outline/store.svelte.ts
import { createTree, childrenOf, type OutlineTree, type OutlineNode } from './model'
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
  dirty: false,
  externalConflict: false,
  backlinkIndex: null,
})

export function bump(): void { outline.version++ }

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

// ---------- IO 管线（组件层通过这些函数驱动；手动验证覆盖） ----------

let ourLastWrite = ''   // 识别自写事件，避免 file-watcher 回环

export async function attachTab(mainPath: string, mainContent: string): Promise<void> {
  const companion = companionPathFor(mainPath)
  if (!companion) { detach(); return }
  if (outline.mainPath === mainPath) return
  outline.mainPath = mainPath
  outline.companionPath = companion
  outline.editingId = null
  outline.dirty = false
  outline.externalConflict = false
  const { exists, readTextFile } = await import('@tauri-apps/plugin-fs')
  if (await exists(companion).catch(() => false)) {
    const text = await readTextFile(companion).catch(() => null)
    outline.tree = text != null ? parseOutline(text) : createTree()
  } else {
    outline.tree = createTree()
  }
  // 附加后立刻对当前主文内容跑一次同步（含首开派生）
  syncAutoItems(outline.tree, deriveAutoItems(mainContent))
  bump()
}

export function detach(): void {
  outline.mainPath = null
  outline.companionPath = null
  outline.tree = createTree()
  outline.editingId = null
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
  if (!outline.dirty || !outline.companionPath) return
  const text = serializeOutline(outline.tree, persistIdsFor(outline.tree))
  ourLastWrite = text
  const { writeTextFile } = await import('@tauri-apps/plugin-fs')
  try {
    await writeTextFile(outline.companionPath, text)
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
