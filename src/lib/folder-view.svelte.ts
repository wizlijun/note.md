import { readDir } from '@tauri-apps/plugin-fs'
import { Store } from '@tauri-apps/plugin-store'
import { SvelteMap } from 'svelte/reactivity'
import { SvelteSet } from 'svelte/reactivity'
import { classifyPath, type FileKind } from './fs'
import { isPluginEnabled } from './settings.svelte'

/** Plugin id under which Folder View is enabled/disabled in `plugins.enabled`. */
export const PLUGIN_ID = 'folder-view'

export interface FolderEntry {
  name: string
  path: string
  isDir: boolean
  kind: FileKind | null // null = directory or unsupported file type
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
  expanded: new SvelteSet(),
  entriesCache: new SvelteMap(),
})

function joinPath(dir: string, name: string): string {
  return (dir.endsWith('/') ? dir.slice(0, -1) : dir) + '/' + name
}

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
  const sorted = sortEntries(entries)
  folderView.entriesCache.set(dir, sorted)
  return sorted
}

/** Set the tree root and eagerly read it. */
export async function setRootDir(dir: string): Promise<void> {
  folderView.rootDir = dir
  folderView.expanded.clear()
  await readFolder(dir).catch(() => {})
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
