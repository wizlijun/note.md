import { isManagedMemoryTab, type Tab } from '../tabs.svelte'
import type { FileViewRef } from './file-views'
import { fileViewFor } from './file-views'
import type { FileViewContribution, PluginManifest } from './types'

export interface OpenFileViewDetail extends FileViewRef {
  tabId: string
}

interface FileViewCommandDeps {
  activeTab(): Tab | null
  pickOpenFile(): Promise<string | null>
  openFile(path: string): Promise<void>
  flush(tabId: string): void
  setRichMode(tabId: string): void
  openView(detail: OpenFileViewDetail): void
  unsupported(view: FileViewContribution): void
}

function commandView(manifest: PluginManifest, command: string): FileViewContribution | null {
  if (Object.hasOwn(manifest.open_windows ?? {}, command)) return null
  const matches = manifest.file_views?.filter((view) => view.open_command === command) ?? []
  return matches.length === 1 ? matches[0] : null
}

function matchingRef(manifest: PluginManifest, view: FileViewContribution, tab: Tab): FileViewRef | null {
  if (isManagedMemoryTab(tab)) return null
  return fileViewFor(
    { path: tab.filePath, kind: tab.kind, content: tab.currentContent },
    [{ ...manifest, file_views: [view] }],
  )
}

/**
 * Handle a menu command owned by a declarative file view. Returns false when
 * the command is unrelated, allowing the ordinary plugin process/window path
 * to continue. UI-only file-view commands are otherwise fully host-owned.
 */
export async function dispatchFileViewCommand(
  manifest: PluginManifest,
  command: string,
  deps: FileViewCommandDeps,
): Promise<boolean> {
  const view = commandView(manifest, command)
  if (!view) return false

  let tab = deps.activeTab()
  if (!tab) {
    const path = await deps.pickOpenFile()
    if (!path) return true
    await deps.openFile(path)
    tab = deps.activeTab()
  }
  if (!tab) return true

  // Rich editors flush synchronously on this event. Match the latest text,
  // including a frontmatter edit that has not reached the tab snapshot yet.
  deps.flush(tab.id)
  const ref = matchingRef(manifest, view, tab)
  if (!ref) {
    deps.unsupported(view)
    return true
  }

  deps.setRichMode(tab.id)
  deps.openView({ tabId: tab.id, ...ref })
  return true
}
