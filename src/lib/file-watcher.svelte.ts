import { tabs, type Tab } from './tabs.svelte'
import { readMd, statFile } from './fs'
import { sha256Hex } from './hash'
import { decide, type ExternalEvent } from './external-state'

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
      tab.initialContent = s.content
      tab.currentContent = s.content
      tab.lastKnownMtime = s.mtime
      tab.lastKnownHash = s.hash
      tab.externalState = 'fresh'
      tab.externalBannerDismissed = false
      tab.pendingExternal = undefined
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
