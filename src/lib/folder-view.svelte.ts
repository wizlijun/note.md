import { readDir, watchImmediate } from '@tauri-apps/plugin-fs'
import { Store } from '@tauri-apps/plugin-store'
import { SvelteMap } from 'svelte/reactivity'
import { SvelteSet } from 'svelte/reactivity'
import { classifyPath, joinPath, type FileKind } from './fs'
import { isPluginEnabled } from './settings.svelte'

/** Plugin id under which Folder View is enabled/disabled in `plugins.enabled`. */
export const PLUGIN_ID = 'folder-view'

export interface FolderEntry {
  name: string
  path: string
  isDir: boolean
  kind: FileKind | null // null = directory or unsupported file type
  /** 独立大纲笔记(.note.md 无同名主文档):专属 note 图标 */
  isOutlineNote?: boolean
  /** 同目录存在配对 xxx.note.md:行尾角标,点击打开笔记 */
  hasNote?: boolean
  notePath?: string
}

/** Parent directory of a file or directory path. Returns '/' at the root. */
export function parentDir(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  const i = trimmed.lastIndexOf('/')
  if (i <= 0) return '/'
  return trimmed.slice(0, i)
}

/** True when `file` is strictly inside directory `dir` (any depth). */
export function isWithinDir(file: string, dir: string): boolean {
  const d = dir.length > 1 ? dir.replace(/\/+$/, '') : dir
  const prefix = d === '/' ? '/' : d + '/'
  return file !== d && file.startsWith(prefix)
}

/**
 * Compile a filter query into a name matcher. Empty/blank query → `null`
 * (meaning "match everything"). The query is treated as a case-insensitive
 * regular expression; an invalid pattern (e.g. a half-typed `(`) falls back to
 * a case-insensitive substring match so live typing keeps filtering sensibly.
 */
export function makeFilterMatcher(query: string): ((name: string) => boolean) | null {
  const q = query.trim()
  if (!q) return null
  try {
    const re = new RegExp(q, 'i')
    return (name) => re.test(name)
  } catch {
    const lower = q.toLowerCase()
    return (name) => name.toLowerCase().includes(lower)
  }
}

/**
 * Compute the set of paths that should stay visible under `query`, searching
 * the whole cached subtree under `rootDir`. A path is visible when:
 *   - it is a file whose name matches, or
 *   - it is a folder whose name matches (its entire subtree is then included), or
 *   - it is an ancestor folder on the path to any matching descendant.
 * Returns `null` when the query is empty (meaning "show everything").
 */
export function computeFilterVisibility(
  rootDir: string,
  cache: Map<string, FolderEntry[]>,
  query: string,
): Set<string> | null {
  const match = makeFilterMatcher(query)
  if (!match) return null
  const visible = new Set<string>()
  // `inherited` is true once an ancestor folder's name has matched, so its
  // whole subtree is included regardless of individual names.
  const walk = (entry: FolderEntry, inherited: boolean): boolean => {
    const selfMatch = inherited || match(entry.name)
    if (!entry.isDir) {
      if (selfMatch) visible.add(entry.path)
      return selfMatch
    }
    let anyChild = false
    for (const child of cache.get(entry.path) ?? []) {
      if (walk(child, selfMatch)) anyChild = true
    }
    const vis = selfMatch || anyChild
    if (vis) visible.add(entry.path)
    return vis
  }
  for (const e of cache.get(rootDir) ?? []) walk(e, false)
  return visible
}

const NOTE_SUFFIX_RE = /\.notes?\.md$/i

/** 同目录配对:xxx.note.md 有同名 xxx.md → 隐藏该行并给主行打 hasNote;
 *  无主文档的 .note.md 保留行并标 isOutlineNote。 */
export function pairNoteEntries(entries: FolderEntry[]): FolderEntry[] {
  const names = new Set(entries.filter(e => !e.isDir).map(e => e.name.toLowerCase()))
  const noteFor = new Map<string, FolderEntry>() // 主文件名(小写) → 笔记 entry
  for (const e of entries) {
    if (e.isDir || !NOTE_SUFFIX_RE.test(e.name)) continue
    const mainName = e.name.replace(NOTE_SUFFIX_RE, '.md').toLowerCase()
    if (names.has(mainName)) noteFor.set(mainName, e)
  }
  const out: FolderEntry[] = []
  for (const e of entries) {
    if (!e.isDir && NOTE_SUFFIX_RE.test(e.name)) {
      const mainName = e.name.replace(NOTE_SUFFIX_RE, '.md').toLowerCase()
      if (names.has(mainName)) continue            // 伴生:行隐藏
      out.push({ ...e, isOutlineNote: true })       // 独立笔记
      continue
    }
    const note = !e.isDir ? noteFor.get(e.name.toLowerCase()) : undefined
    out.push(note ? { ...e, hasNote: true, notePath: note.path } : e)
  }
  return out
}

/** Folders first, then files; each group sorted by name, case-insensitive. */
export function sortEntries(entries: FolderEntry[]): FolderEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

export interface FolderViewState {
  enabled: boolean
  visible: boolean
  width: number
  rootDir: string | null
  /** Live name filter (regex, case-insensitive); empty = no filtering. */
  filter: string
  /** Paths kept visible by the active filter (recursive; empty when no filter). */
  filterVisible: SvelteSet<string>
  expanded: SvelteSet<string>
  entriesCache: SvelteMap<string, FolderEntry[]>
}

export const DEFAULT_WIDTH = 240
export const MIN_WIDTH = 160
export const MAX_WIDTH = 480

export const folderView = $state<FolderViewState>({
  enabled: true,
  visible: false,
  width: DEFAULT_WIDTH,
  rootDir: null,
  filter: '',
  filterVisible: new SvelteSet(),
  expanded: new SvelteSet(),
  entriesCache: new SvelteMap(),
})

/** Read a directory, classify + sort entries, hide dotfiles, and cache. */
export async function readFolder(dir: string): Promise<FolderEntry[]> {
  const raw = await readDir(dir)
  const entries: FolderEntry[] = raw
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const path = joinPath(dir, e.name)
      return {
        name: e.name,
        path,
        isDir: !!e.isDirectory,
        kind: e.isDirectory ? null : (classifyPath(path)?.kind ?? null),
      }
    })
  const sorted = sortEntries(pairNoteEntries(entries))
  folderView.entriesCache.set(dir, sorted)
  return sorted
}

/** Reveal a file/folder in the OS file browser (Finder), selecting the item. */
export async function revealInFinder(path: string): Promise<void> {
  const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
  await revealItemInDir(path)
}

/** Set the tree root and eagerly read it. */
export async function setRootDir(dir: string): Promise<void> {
  folderView.rootDir = dir
  folderView.expanded.clear()
  await readFolder(dir).catch(() => {})
  // Re-run an active filter against the new root's subtree.
  if (folderView.filter.trim()) await setFilter(folderView.filter)
}

/**
 * React to the active file changing. Reset the root to the file's parent only
 * when the file is outside the current root's subtree (VS Code "reveal"
 * behavior); otherwise keep the root so browsing position is preserved.
 */
export async function syncToActiveFile(filePath: string | null): Promise<void> {
  if (!filePath) return
  const parent = parentDir(filePath)
  if (folderView.rootDir && (folderView.rootDir === parent || isWithinDir(filePath, folderView.rootDir))) {
    return
  }
  await setRootDir(parent)
}

// Bumped on every filter change so a slow recursive load can tell it has been
// superseded by newer input and skip its (now stale) recompute.
let filterSeq = 0

/**
 * Set the live name filter (not persisted). Loads the whole subtree under the
 * root so matches in any subfolder are found, then recomputes visibility.
 */
export async function setFilter(q: string): Promise<void> {
  folderView.filter = q
  const seq = ++filterSeq
  if (!q.trim() || !folderView.rootDir) {
    folderView.filterVisible.clear()
    return
  }
  await ensureSubtreeLoaded(folderView.rootDir)
  if (seq !== filterSeq) return // a newer query took over while we loaded
  recomputeFilter()
}

/** Clear the name filter and cancel any in-flight recursive load. */
export function clearFilter(): void {
  folderView.filter = ''
  folderView.filterVisible.clear()
  filterSeq++
}

/** Recompute `filterVisible` from the current cache + filter. */
function recomputeFilter(): void {
  const vis = folderView.rootDir
    ? computeFilterVisibility(folderView.rootDir, folderView.entriesCache, folderView.filter)
    : null
  folderView.filterVisible.clear()
  if (vis) for (const p of vis) folderView.filterVisible.add(p)
}

/** Recursively read every folder under `dir` (skipping already-cached ones). */
async function ensureSubtreeLoaded(dir: string): Promise<void> {
  if (!folderView.entriesCache.has(dir)) await readFolder(dir).catch(() => {})
  const dirs = (folderView.entriesCache.get(dir) ?? []).filter((e) => e.isDir)
  await Promise.all(dirs.map((e) => ensureSubtreeLoaded(e.path)))
}

/** Expand/collapse a folder; read its children on first expand. */
export async function toggleExpanded(dir: string): Promise<void> {
  if (folderView.expanded.has(dir)) {
    folderView.expanded.delete(dir)
  } else {
    folderView.expanded.add(dir)
    if (!folderView.entriesCache.has(dir)) await readFolder(dir).catch(() => {})
  }
}

/** Re-read every directory currently cached (manual refresh). */
export async function refreshAll(): Promise<void> {
  const dirs = [...folderView.entriesCache.keys()]
  await Promise.all(dirs.map((d) => readFolder(d).catch(() => {})))
  // Keep the active filter current: pick up newly added subfolders/files.
  if (folderView.filter.trim() && folderView.rootDir) {
    await ensureSubtreeLoaded(folderView.rootDir)
    recomputeFilter()
  }
}

/**
 * Watch `dir` recursively and re-read the visible tree (debounced) whenever the
 * filesystem changes under it, so newly created / deleted / renamed files show
 * up without a manual refresh. Returns an unwatch function that's safe to call
 * even while the underlying watch is still starting.
 */
export function watchRoot(dir: string): () => void {
  let stop: (() => void) | null = null
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { void refreshAll() }, 150)
  }
  watchImmediate(dir, schedule, { recursive: true })
    .then((s) => { if (cancelled) { try { s() } catch { /* ignore */ } } else { stop = s } })
    .catch((e) => console.warn('[folder-view] watch failed for', dir, e))
  return () => {
    cancelled = true
    if (timer) { clearTimeout(timer); timer = null }
    if (stop) { try { stop() } catch (e) { console.warn('[folder-view] unwatch failed:', e) } stop = null }
  }
}

// ---- persistence (settings.json store; shared with settings.svelte.ts) ----

let store: Awaited<ReturnType<typeof Store.load>> | null = null
async function getStore() {
  if (!store) store = await Store.load('settings.json')
  return store
}

export async function loadFolderViewState(): Promise<void> {
  // Enabled state is managed through the shared `plugins.enabled` map (same as
  // external plugins), read here after settings have hydrated. Absent → on.
  folderView.enabled = isPluginEnabled(PLUGIN_ID)
  const s = await getStore()
  folderView.visible = (await s.get<boolean>('folderView.visible')) ?? false
  folderView.width = (await s.get<number>('folderView.width')) ?? DEFAULT_WIDTH
}

export async function setVisible(v: boolean): Promise<void> {
  folderView.visible = v
  const s = await getStore()
  await s.set('folderView.visible', v)
  await s.save()
}

export async function setWidth(w: number): Promise<void> {
  const clamped = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)))
  folderView.width = clamped
  const s = await getStore()
  await s.set('folderView.width', clamped)
  await s.save()
}
