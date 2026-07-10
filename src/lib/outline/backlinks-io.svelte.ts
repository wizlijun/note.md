// src/lib/outline/backlinks-io.svelte.ts
import { watchImmediate } from '@tauri-apps/plugin-fs'
import { outline, bump } from './store.svelte'
import { buildFolderIndex, refreshFileInIndex, pageNameOf } from './backlinks'
import { folderView, parentDir } from '../folder-view.svelte'
import { openFile } from '../tabs.svelte'

let unwatch: (() => void) | null = null
let indexedRoot: string | null = null
let indexGen = 0

/** 面板首次显示/主文件换目录时调用；插件关闭时 teardownIndex() */
export async function ensureIndex(mainPath: string): Promise<void> {
  // 范围：FolderView 根目录；未开文件夹 → 主文件所在目录
  const root = folderView.rootDir ?? parentDir(mainPath)
  if (indexedRoot === root && outline.backlinkIndex) return
  teardownIndex()
  const gen = ++indexGen
  indexedRoot = root
  const idx = await buildFolderIndex(root)
  if (gen !== indexGen) return   // superseded by teardown or a concurrent call
  outline.backlinkIndex = idx
  bump()
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<string>()
  watchImmediate(root, (ev) => {
    for (const p of (ev.paths ?? [])) if (/\.md$/i.test(p)) pending.add(p)
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      const current = outline.backlinkIndex
      if (!current) return
      for (const p of [...pending]) { pending.delete(p); await refreshFileInIndex(current, p) }
      bump()
    }, 300)
  }, { recursive: true })
    .then(s => {
      if (gen !== indexGen) { try { s() } catch { /* ignore */ } }
      else { unwatch = s }
    })
    .catch(e => console.warn('[outline] backlink watch failed:', e))
}

export function teardownIndex(): void {
  indexGen++
  if (unwatch) { try { unwatch() } catch { /* ignore */ } unwatch = null }
  outline.backlinkIndex = null
  indexedRoot = null
}

/** 点击 [[页面]]：找同目录同名 .md 打开；不存在则创建后打开 */
export async function openPageOrCreate(target: string): Promise<void> {
  const dir = indexedRoot ?? (outline.mainPath ? parentDir(outline.mainPath) : null)
  if (!dir) return
  const idx = outline.backlinkIndex
  const existing = idx ? [...idx.filePages.entries()].find(
    ([p, page]) => page.toLowerCase() === target.toLowerCase() && !/\.notes?\.md$/i.test(p)) : null
  if (existing) { await openFile(existing[0]); return }
  const path = `${dir}/${target}.md`
  const { exists, writeTextFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path).catch(() => false))) {
    await writeTextFile(path, `# ${target}\n`)
  }
  await openFile(path)
}

export function currentPageName(): string | null {
  return outline.mainPath ? pageNameOf(outline.mainPath) : null
}
