// src/lib/outline/backlinks.ts
import { parseInline } from './parser'
import { basename, joinPath } from '../fs'

export interface BacklinkHit { file: string; text: string; line: number }

export interface BacklinkIndex {
  /** lowercased target → hits */
  byTarget: Map<string, BacklinkHit[]>
  /** file → its targets（增量更新用） */
  fileTargets: Map<string, Set<string>>
  /** 已索引文件的页面名（[[ 补全候选） */
  filePages: Map<string, string>
}

export function createIndex(): BacklinkIndex {
  return { byTarget: new Map(), fileTargets: new Map(), filePages: new Map() }
}

export function pageNameOf(path: string): string {
  return basename(path).replace(/\.notes?\.md$/i, '').replace(/\.md$/i, '')
}

export function removeFileFromIndex(idx: BacklinkIndex, file: string): void {
  const targets = idx.fileTargets.get(file)
  if (targets) {
    for (const t of targets) {
      const hits = idx.byTarget.get(t)?.filter(h => h.file !== file) ?? []
      if (hits.length) idx.byTarget.set(t, hits)
      else idx.byTarget.delete(t)
    }
  }
  idx.fileTargets.delete(file)
  idx.filePages.delete(file)
}

/** 单文件（重新）索引：逐行提取 [[..]] 与 #tag */
export function indexFileContent(idx: BacklinkIndex, file: string, content: string): void {
  removeFileFromIndex(idx, file)
  idx.filePages.set(file, pageNameOf(file))
  const targets = new Set<string>()
  content.split('\n').forEach((rawLine, i) => {
    const text = rawLine.replace(/^\s*- /, '').trim()
    if (!text) return
    for (const node of parseInline(text)) {
      let target: string | null = null
      if (node.t === 'page-link') target = node.target
      else if (node.t === 'hashtag') target = node.tag
      if (!target) continue
      const key = target.toLowerCase()
      targets.add(key)
      const hits = idx.byTarget.get(key) ?? []
      hits.push({ file, text, line: i + 1 })
      idx.byTarget.set(key, hits)
    }
  })
  idx.fileTargets.set(file, targets)
}

export function backlinksFor(idx: BacklinkIndex, page: string): BacklinkHit[] {
  return idx.byTarget.get(page.toLowerCase()) ?? []
}

export function pageCandidates(idx: BacklinkIndex): string[] {
  return [...new Set(idx.filePages.values())]
}

// ---------- IO（组件层调用；vitest 不覆盖，走手动验证） ----------

const MAX_FILE_BYTES = 1024 * 1024 // spec 性能护栏：仅解析 ≤1MB

/** 扫描 rootDir 下所有 .md 建全量索引（递归、跳过点目录/点文件） */
export async function buildFolderIndex(rootDir: string): Promise<BacklinkIndex> {
  const { readDir, readTextFile, stat } = await import('@tauri-apps/plugin-fs')
  const idx = createIndex()
  const walk = async (dir: string): Promise<void> => {
    const entries = await readDir(dir).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      if (e.isSymlink) continue // skip symlinks to avoid cycle risk
      const path = joinPath(dir, e.name)
      if (e.isDirectory) { await walk(path); continue }
      if (!/\.md$/i.test(e.name)) continue
      const info = await stat(path).catch(() => null)
      if (info && info.size > MAX_FILE_BYTES) continue
      const content = await readTextFile(path).catch(() => null)
      if (content != null) indexFileContent(idx, path, content)
    }
  }
  await walk(rootDir)
  return idx
}

/** file-watcher 事件驱动的单文件增量重扫 */
export async function refreshFileInIndex(idx: BacklinkIndex, path: string): Promise<void> {
  if (!/\.md$/i.test(path)) return
  const { readTextFile } = await import('@tauri-apps/plugin-fs')
  const content = await readTextFile(path).catch(() => null)
  if (content == null) removeFileFromIndex(idx, path)
  else indexFileContent(idx, path, content)
}
