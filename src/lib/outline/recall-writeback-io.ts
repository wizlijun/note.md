// src/lib/outline/recall-writeback-io.ts
// Apply a Linked-References node edit back to its SOURCE outline file: through
// the open tab when there is one (keeps undo/dirty semantics), else straight to
// disk. Mirrors note-writeback-io.ts. Text-only, single node (Phase B / B1).
import { tabs, setContent } from '../tabs.svelte'
import { pushToast } from '../toast.svelte'
import { t } from '../i18n/store.svelte'
import { editNodeInOutline } from './recall'

/**
 * Commit one reference node's text back to `file`. Returns true on success;
 * false + a "not synced" toast when the node can't be located (the file changed
 * underneath, or the node is read-only).
 */
export async function commitReferenceEdit(
  file: string,
  path: number[],
  oldText: string,
  newText: string,
): Promise<boolean> {
  const ok = await (async () => {
    const tab = tabs.find(tb => tb.filePath === file)
    if (tab) {
      const next = editNodeInOutline(tab.currentContent, path, oldText, newText)
      if (next == null) return false
      setContent(tab.id, next)
      return true
    }
    try {
      const fs = await import('@tauri-apps/plugin-fs')
      const md = await fs.readTextFile(file)
      const next = editNodeInOutline(md, path, oldText, newText)
      if (next == null) return false
      await fs.writeTextFile(file, next)
      return true
    } catch {
      return false
    }
  })()
  if (!ok) pushToast({ level: 'warn', message: t('outline.refWriteFailed') })
  return ok
}
