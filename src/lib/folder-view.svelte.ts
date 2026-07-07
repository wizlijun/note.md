import { readDir } from '@tauri-apps/plugin-fs'
import { Store } from '@tauri-apps/plugin-store'
import { classifyPath, type FileKind } from './fs'

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
