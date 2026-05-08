import { tabs, isDirty, recordOurWrite } from './tabs.svelte'
import { writeMd } from './fs'
import { settings } from './settings.svelte'

const DEBOUNCE_MS = 800
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function startAutoSaveWatcher(): () => void {
  const stop = $effect.root(() => {
    $effect(() => {
      if (!settings.autoSave) {
        for (const t of timers.values()) clearTimeout(t)
        timers.clear()
        return
      }
      for (const tab of tabs) {
        // Image files have no text content and are never dirty; skip entirely.
        if (tab.kind === 'image') continue
        // Auto-save is on hold while the user reconciles an external change;
        // resuming would silently overwrite either the disk or the buffer.
        if (tab.externalState !== 'fresh') {
          const t = timers.get(tab.id)
          if (t) { clearTimeout(t); timers.delete(tab.id) }
          continue
        }
        const content = tab.currentContent
        const id = tab.id
        const path = tab.filePath
        const dirty = isDirty(id)
        const existing = timers.get(id)
        if (existing) clearTimeout(existing)
        if (!dirty) continue
        const timer = setTimeout(async () => {
          try {
            await writeMd(path, content)
            const cur = tabs.find((x) => x.id === id)
            if (cur && cur.currentContent === content) {
              cur.initialContent = content
              // Suppress the imminent watcher echo: capture post-write
              // mtime+hash so the change-detection state machine can ignore
              // our own write. Without this, every autosave would surface a
              // spurious external-change banner ~1 s later.
              await recordOurWrite(cur)
            }
          } catch (e) {
            console.warn('[autosave] failed:', path, e)
          }
        }, DEBOUNCE_MS)
        timers.set(id, timer)
      }
    })
  })

  return () => {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    stop()
  }
}
