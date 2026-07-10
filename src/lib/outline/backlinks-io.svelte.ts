// src/lib/outline/backlinks-io.svelte.ts
import { watchImmediate } from '@tauri-apps/plugin-fs'
import { outline, bump } from './store.svelte'
import { buildFolderIndex, refreshFileInIndex, pageNameOf, resolveTarget, detectNameCollisions } from './backlinks'
import { sanitizeFileName } from './slug'
import { outlineDirs } from './dirs.svelte'
import { folderView, parentDir } from '../folder-view.svelte'
import { openFile } from '../tabs.svelte'
import { t } from '../i18n/store.svelte'
import { pushToast } from '../toast.svelte'
import { sotvaultStore } from '../sotvault.svelte'
import { isUnder } from '../recent-merge'
import { joinPath } from '../fs'
import { ensureOutlineFile } from './create'

let unwatch: (() => void) | null = null
let indexedRoot: string | null = null
let indexGen = 0

/** 索引根(spec §5):文件在 vault 内 → vault 根(全局命名空间);
 *  否则维持现状(FolderView 根 → 文件所在目录)。 */
function indexRootFor(path: string): string {
  const vault = sotvaultStore.vaultRoot
  if (vault && isUnder(path, vault)) return vault
  return folderView.rootDir ?? parentDir(path)
}

/** 面板首次显示/主文件换目录时调用；插件关闭时 teardownIndex() */
export async function ensureIndex(mainPath: string): Promise<void> {
  const root = indexRootFor(mainPath)
  if (indexedRoot === root && outline.backlinkIndex) return
  teardownIndex()
  const gen = ++indexGen
  indexedRoot = root
  const idx = await buildFolderIndex(root, (legacyPath) => {
    pushToast({ level: 'warn', message: t('outline.migrate.conflict', { path: legacyPath }) })
  })
  if (gen !== indexGen) return   // superseded by teardown or a concurrent call
  outline.backlinkIndex = idx
  bump()
  const collisions = detectNameCollisions(idx)
  if (collisions.size > 0) {
    const [name, files] = [...collisions.entries()][0]
    pushToast({ level: 'warn', message: t('outline.nameCollision', {
      n: String(collisions.size), name, files: files.join('\n') }) })
    console.warn('[outline] name collisions:', Object.fromEntries(collisions))
  }
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

/** 点击 [[页面]]:全局解析(resolveTarget);未解析 → vault 内建 wikipage
 *  大纲页,vault 外维持旧行为(同目录建 .md)。 */
export async function openPageOrCreate(target: string): Promise<void> {
  const idx = outline.backlinkIndex
  const existing = idx ? (resolveTarget(idx, target) ?? resolveTarget(idx, sanitizeFileName(target))) : null
  if (existing) { await openFile(existing); return }
  const safe = sanitizeFileName(target)
  const docPath = outline.docPath
  const vault = sotvaultStore.vaultRoot
  if (vault && docPath && isUnder(docPath, vault)) {
    // spec §5:vault 内未解析链接 → vault/{wikipage}/{slug}.note.md,fm title 存原文
    const { mkdir } = await import('@tauri-apps/plugin-fs')
    const dir = joinPath(vault, outlineDirs.wikipage)
    await mkdir(dir, { recursive: true }).catch(() => {})
    const path = joinPath(dir, `${safe}.note.md`)
    await ensureOutlineFile(path, target)
    await openFile(path)
    return
  }
  // vault 外:维持现状(同目录建 .md)
  const dir = indexedRoot ?? (docPath ? parentDir(docPath) : null)
  if (!dir) return
  const path = joinPath(dir, `${safe}.md`)
  const { exists, writeTextFile } = await import('@tauri-apps/plugin-fs')
  if (!(await exists(path).catch(() => false))) {
    await writeTextFile(path, `# ${safe}\n`)
  }
  await openFile(path)
}
