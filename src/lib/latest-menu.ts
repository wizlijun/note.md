import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { homeDir } from '@tauri-apps/api/path'
import { watchImmediate, type WatchEvent } from '@tauri-apps/plugin-fs'
import { formatRecentLabel } from './recent-merge'

/** Match the metadata walk's exclusions, without hiding user dot-directories. */
export function affectsLatestFiles(event: WatchEvent, root: string): boolean {
  if (typeof event.type === 'object' && 'access' in event.type) return false
  const prefix = root.replace(/\\/g, '/').replace(/\/$/, '') + '/'
  return event.paths.length === 0 || event.paths.some((path) => {
    const normalized = path.replace(/\\/g, '/')
    if (normalized === prefix.slice(0, -1)) return true
    if (!normalized.startsWith(prefix)) return false
    const parts = normalized.slice(prefix.length).split('/')
    return !parts.some((part) => ['.git', '.notemd', '.trash'].includes(part))
  })
}

/** Menu reads cached items; only startup, filesystem changes and focus scan metadata. */
export function installLatestMenu(root: string | null): () => void {
  let stopped = false
  let paths: string[] = []
  let home: string | null = null
  let scanning = false
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanups: (() => void)[] = []

  function keepCleanup(cleanup: () => void) {
    if (stopped) cleanup()
    else cleanups.push(cleanup)
  }
  function publish() {
    if (stopped) return
    void invoke('update_latest_menu', {
      items: paths.map((path) => ({ path, label: formatRecentLabel(path, home) })),
    }).catch((e) => console.warn('[latest-menu] publish:', e))
  }
  async function scan() {
    if (stopped || !root) return
    if (scanning) { dirty = true; return }
    scanning = true
    dirty = false
    try {
      const result = await invoke<string[]>('latest_vault_files', { vaultRoot: root })
      if (stopped) return
      paths = result
      publish()
    } catch (e) {
      if (!stopped) {
        paths = []
        publish()
        console.warn('[latest-menu] scan:', e)
      }
    } finally {
      scanning = false
      if (dirty && !stopped) schedule()
    }
  }
  // Throttle instead of resetting the timer: continuous autosaves must not starve updates.
  function schedule() {
    if (stopped || timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; void scan() }, 1000)
  }

  publish() // Immediately discard the previous vault's cached menu.
  void homeDir().then((value) => { home = value; publish() }).catch(() => {})
  void listen('menu-rebuilt', publish).then(keepCleanup).catch((e) => console.warn('[latest-menu] listen:', e))
  if (root) {
    // Register before scanning so a file change during the initial walk is not lost.
    void watchImmediate(root, (event) => {
      if (affectsLatestFiles(event, root)) schedule()
    }, { recursive: true }).then(keepCleanup)
      .catch((e) => console.warn('[latest-menu] watch:', e))
      .finally(() => { void scan() })
    window.addEventListener('focus', schedule)
    cleanups.push(() => window.removeEventListener('focus', schedule))
  }
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    for (const cleanup of cleanups) cleanup()
  }
}
