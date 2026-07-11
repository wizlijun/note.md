// src/lib/roam-import/plan.ts
import { sanitizeFileName } from '../outline/slug'
import { dailyDateFromUid } from './parse'
import type { ImportManifest, RoamPage } from './types'

export interface PageFile {
  page: RoamPage
  kind: 'daily' | 'wiki'
  /** vault 相对路径 */
  relPath: string
  /** wiki 页最终文件名(= wikilink 目标);daily 页为日期串 */
  finalName: string
}

export interface AssignResult {
  files: PageFile[]
  /** 原标题 → 最终名(仅收录发生变化的),驱动全图 [[链接]] 重写 */
  renames: Map<string, string>
  warnings: string[]
}

/** 页面 → 文件路径。碰撞检测大小写不敏感(macOS 文件系统),后缀 " (2)" 起。 */
export function assignFiles(pages: RoamPage[], dirs: { wikipage: string; dailynote: string }): AssignResult {
  const files: PageFile[] = []
  const renames = new Map<string, string>()
  const warnings: string[] = []
  const taken = new Set<string>()
  for (const page of pages) {
    const daily = dailyDateFromUid(page.uid)
    if (daily) {
      files.push({ page, kind: 'daily', relPath: `${dirs.dailynote}/${daily.slice(0, 4)}/${daily}.note.md`, finalName: daily })
      continue
    }
    const base = sanitizeFileName(page.title)
    let name = base
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`
    taken.add(name.toLowerCase())
    if (name !== base) warnings.push(`title collision: "${page.title}" → "${name}"`)
    if (name !== page.title) renames.set(page.title, name)
    files.push({ page, kind: 'wiki', relPath: `${dirs.wikipage}/${name}.note.md`, finalName: name })
  }
  return { files, renames, warnings }
}

export type ImportAction = 'create' | 'overwrite' | 'skip' | 'conflict'
export interface PlannedPage { key: string; relPath: string; action: ImportAction }

/**
 * 增量动作判定(spec §增量重导):
 * 清单无记录或本地文件不存在 → create;edit-time 未变 → skip;
 * 变了且本地 hash 与清单一致 → overwrite;本地被改过 → conflict。
 * localHashes: relPath → 现文件 sha256(不存在为 null/缺省)。
 */
export function planActions(
  entries: Array<{ key: string; relPath: string; editTime: number }>,
  manifest: ImportManifest | null,
  localHashes: Map<string, string | null>,
): PlannedPage[] {
  return entries.map(({ key, relPath, editTime }) => {
    const prev = manifest?.pages[key]
    const local = localHashes.get(relPath) ?? null
    if (!prev || local == null) return { key, relPath, action: 'create' as const }
    if (prev.editTime === editTime) return { key, relPath, action: 'skip' as const }
    if (local === prev.contentHash) return { key, relPath, action: 'overwrite' as const }
    return { key, relPath, action: 'conflict' as const }
  })
}
