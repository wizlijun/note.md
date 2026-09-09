import { isManagedMemoryTab, setMode, type Tab } from '../tabs.svelte'
import { fileViewFor, type FileViewRef } from './file-views'
import {
  fileViewSelection as selection,
  resetFileViewSelection,
  setFileViewSelection,
  type FileViewFallbackReason,
} from './file-view-selection.svelte'
import type { PluginManifest } from './types'
import { builtinFileViewFor, builtinFileViewManifests, isBuiltinOutlineFileView } from './builtin-file-views'

export type { FileViewFallbackReason } from './file-view-selection.svelte'

export interface FileViewPresentation {
  active: FileViewRef | null
  candidate: FileViewRef | null
  explicit: FileViewRef | null
  fallback?: { view: FileViewRef; reason: FileViewFallbackReason }
  attempt: number
}

function sameView(a: FileViewRef | null | undefined, b: FileViewRef): boolean {
  return !!a && a.pluginId === b.pluginId && a.viewId === b.viewId && a.entry === b.entry
}

export function fileViewManifest(
  tab: Tab,
  view: FileViewRef,
  manifests: PluginManifest[],
): PluginManifest | undefined {
  return [...builtinFileViewManifests(tab), ...manifests].find((manifest) => manifest.id === view.pluginId
    && manifest.file_views?.some((item) => item.id === view.viewId && item.entry === view.entry))
}

export function isFileViewAvailable(view: FileViewRef, manifests: PluginManifest[], tab?: Tab): boolean {
  if (isBuiltinOutlineFileView(view)) return !!tab && !!fileViewManifest(tab, view, manifests)
  return manifests.some((manifest) => manifest.id === view.pluginId
    && manifest.file_views?.some((item) => item.id === view.viewId && item.entry === view.entry))
}

/** Resolve one named view owned by one plugin, while still enforcing its file rules. */
export function matchingDeclaredFileView(
  tab: Tab,
  pluginId: string,
  viewId: string,
  manifests: PluginManifest[],
): FileViewRef | null {
  if (isManagedMemoryTab(tab)) return null
  const manifest = manifests.find((item) => item.id === pluginId)
  const view = manifest?.file_views?.find((item) => item.id === viewId)
  if (!manifest || !view) return null
  return fileViewFor(
    { path: tab.filePath, kind: tab.kind, content: tab.currentContent },
    [{ ...manifest, file_views: [view] }],
  )
}

function automaticView(tab: Tab, manifests: PluginManifest[]): FileViewRef | null {
  if (isManagedMemoryTab(tab)) return null
  // Canonical Note suffixes belong to the built-in outline surface even when
  // an external view also matches their Markdown/frontmatter. Both paths use
  // the same declarative matcher; the separate pass makes core precedence
  // explicit instead of relying on a public priority tie-break.
  return builtinFileViewFor(tab)
    ?? fileViewFor({ path: tab.filePath, kind: tab.kind, content: tab.currentContent }, manifests)
}

/** Resolve the toolbar slot and actual rich-mode surface from one shared state. */
export function fileViewPresentation(tab: Tab, manifests: PluginManifest[]): FileViewPresentation {
  const current = selection(tab.id)
  const automatic = automaticView(tab, manifests)
  const choice = current?.choice
  const explicit = choice && typeof choice === 'object' ? choice : null
  const base = { explicit, fallback: current?.fallback, attempt: current?.attempt ?? 0 }
  if (choice === undefined) return { ...base, active: automatic, candidate: automatic }
  if (choice === null) {
    const fallback = current?.fallback?.view
    const candidate = fallback && isFileViewAvailable(fallback, manifests, tab) ? fallback : automatic
    return { ...base, active: null, candidate }
  }
  const available = isFileViewAvailable(choice, manifests, tab)
  return { ...base, active: available ? choice : null, candidate: available ? choice : null }
}

export function selectRichFileView(tab: Tab): void {
  setMode(tab.id, 'rich')
  setFileViewSelection(tab.id, { choice: null, attempt: selection(tab.id)?.attempt ?? 0 })
}

export function selectSourceFileView(tab: Tab): void {
  setMode(tab.id, 'source')
}

export function selectFileView(tab: Tab, view: FileViewRef): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId: tab.id } }))
  }
  setMode(tab.id, 'rich')
  setFileViewSelection(tab.id, {
    choice: { ...view },
    attempt: (selection(tab.id)?.attempt ?? 0) + 1,
  })
}

export function fallbackFileView(tab: Tab, view: FileViewRef, reason: FileViewFallbackReason): void {
  const current = selection(tab.id)
  if (current?.choice && !sameView(current.choice, view)) return
  setFileViewSelection(tab.id, {
    choice: null,
    fallback: { view: { ...view }, reason },
    attempt: current?.attempt ?? 0,
  })
}

/** A changed file may now parse; retry a fallback, never an explicit Rich choice. */
export function retryFileViewAfterReload(tab: Tab): void {
  const current = selection(tab.id)
  if (!current?.fallback) return
  setFileViewSelection(tab.id, {
    choice: { ...current.fallback.view },
    attempt: current.attempt + 1,
  })
}

export function resetFileViewPresentation(tabId: string): void {
  resetFileViewSelection(tabId)
}
