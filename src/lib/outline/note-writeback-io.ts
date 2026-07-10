// src/lib/outline/note-writeback-io.ts
// Apply a note-child edit back to the MAIN markdown document: through the open
// tab when there is one (keeps undo/dirty semantics), else straight to disk.
import { tabs, setContent } from '../tabs.svelte'
import { outline } from './store.svelte'
import { replaceNoteInMd } from './note-writeback'
import { pushToast } from '../toast.svelte'
import { t } from '../i18n/store.svelte'
import type { OutlineNode } from './model'

/** `X.note.md`（或旧后缀 `X.notes.md`）→ 主文档 `X.md`；非伴生名返回 null */
export function mainPathForNotePath(notePath: string): string | null {
  const m = notePath.match(/^(.*)\.notes?\.md$/i)
  return m ? `${m[1]}.md` : null
}

/**
 * 大纲 note 子节点提交后回写主文档。包裹批注按（原文+旧批注）定位，
 * 失败再按插入点批注（仅旧批注）定位；均不中回 false 并提示。
 */
export async function writeBackNoteEdit(
  node: OutlineNode, oldNote: string, newNote: string,
): Promise<boolean> {
  const parent = node.parentId ? outline.tree.nodes.get(node.parentId) : null
  if (!outline.docPath || !parent || parent.source !== 'annotation') return false
  const mainPath = mainPathForNotePath(outline.docPath)
  if (!mainPath) return false

  const apply = (md: string) =>
    replaceNoteInMd(md, { original: parent.content, oldNote, newNote, anchorLine: parent.anchorLine })
    ?? replaceNoteInMd(md, { original: null, oldNote, newNote, anchorLine: parent.anchorLine })

  const ok = await (async () => {
    const tab = tabs.find(tb => tb.filePath === mainPath)
    if (tab) {
      const next = apply(tab.currentContent)
      if (next == null) return false
      setContent(tab.id, next)
      return true
    }
    try {
      const fs = await import('@tauri-apps/plugin-fs')
      const md = await fs.readTextFile(mainPath)
      const next = apply(md)
      if (next == null) return false
      await fs.writeTextFile(mainPath, next)
      return true
    } catch {
      return false
    }
  })()

  if (!ok) pushToast({ level: 'warn', message: t('outline.noteWriteFailed') })
  return ok
}
