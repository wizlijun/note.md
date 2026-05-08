import { watchImmediate } from '@tauri-apps/plugin-fs'
import { tabs, type Tab } from './tabs.svelte'
import { readMd, statFile } from './fs'
import { sha256Hex } from './hash'
import { decide, type ExternalEvent } from './external-state'
import * as self from './file-watcher.svelte'

/**
 * Visit every open tab, compare its known state to disk, and apply the
 * resulting decision. Called on window-focus and as a fallback when the
 * push-mode watcher misses an event.
 */
export async function verifyAllOpen(): Promise<void> {
  for (const tab of tabs) {
    await checkTab(tab)
  }
}

async function checkTab(tab: Tab): Promise<void> {
  const stat = await statFile(tab.filePath)
  let event: ExternalEvent
  if (!stat) {
    event = { type: 'deleted' }
  } else {
    // Mtime fast path: equal mtime → assume content equal, skip read.
    if (stat.mtime === tab.lastKnownMtime) return
    let content: string
    try {
      content = await readMd(tab.filePath)
    } catch {
      // Read failure between stat and read → treat as deleted.
      applyDecision(tab, { kind: 'showDeleted' })
      return
    }
    const hash = await sha256Hex(content)
    event = { type: 'modified', snapshot: { mtime: stat.mtime, hash, content } }
  }
  const decision = decide(tab, event)
  applyDecision(tab, decision)
}

function applyDecision(
  tab: Tab,
  decision: ReturnType<typeof decide>,
): void {
  switch (decision.kind) {
    case 'ignore':
      return
    case 'autoReload': {
      const s = decision.snapshot
      const oldContent = tab.initialContent
      tab.initialContent = s.content
      tab.currentContent = s.content
      tab.lastKnownMtime = s.mtime
      tab.lastKnownHash = s.hash
      tab.externalState = 'fresh'
      tab.externalBannerDismissed = false
      tab.pendingExternal = undefined
      // Hint for source-mode editor: try to keep the user near where they were.
      window.dispatchEvent(new CustomEvent('mdeditor:auto-reloaded', {
        detail: { tabId: tab.id, oldContent, newContent: s.content },
      }))
      return
    }
    case 'showChanged': {
      tab.pendingExternal = decision.snapshot
      tab.externalState = 'changed'
      // Reset dismissed flag so a *new* event resurfaces the banner.
      tab.externalBannerDismissed = false
      return
    }
    case 'showDeleted': {
      tab.externalState = 'deleted'
      tab.externalBannerDismissed = false
      tab.pendingExternal = undefined
      return
    }
  }
}

type Unwatch = () => void
const subscriptions = new Map<string /* tab.id */, Unwatch>()

export async function startWatchingTab(tab: Tab): Promise<void> {
  if (subscriptions.has(tab.id)) return
  try {
    const stop = await watchImmediate(tab.filePath, () => {
      // Coalesce: any event triggers a verify pass for this single tab.
      void checkTab(tab)
    })
    subscriptions.set(tab.id, stop)
  } catch (e) {
    // Watcher unavailable on this filesystem (network, sandboxed, etc.) —
    // silently degrade; verifyAllOpen on window-focus is the fallback.
    console.warn('[file-watcher] watch failed for', tab.filePath, e)
  }
}

export async function stopWatchingTab(tabId: string): Promise<void> {
  const stop = subscriptions.get(tabId)
  if (!stop) return
  try { stop() } catch (e) { console.warn('[file-watcher] stop failed:', e) }
  subscriptions.delete(tabId)
}

export async function rebindTabPath(tabId: string, newPath: string): Promise<void> {
  await stopWatchingTab(tabId)
  const tab = tabs.find((t) => t.id === tabId)
  if (!tab) return
  // tab.filePath is normally updated by saveAs before this is called; ensure
  // we always watch the latest path (covers callers that didn't pre-set it).
  tab.filePath = newPath
  await startWatchingTab(tab)
}

/**
 * Attach a window-focus listener that triggers `verifyAllOpen`. Returns an
 * uninstall function. Idempotent: calling install twice is safe (the second
 * call replaces the first).
 */
export function installFocusPoll(): () => void {
  // Route through the module namespace so test spies on `verifyAllOpen`
  // (vi.spyOn) intercept the call from within the listener.
  const handler = () => { void self.verifyAllOpen() }
  window.addEventListener('focus', handler)
  return () => window.removeEventListener('focus', handler)
}
