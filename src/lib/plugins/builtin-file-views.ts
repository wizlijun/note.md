import { isOutlineNoteTab } from '../outline/gate.svelte'
import type { Tab } from '../tabs.svelte'
import { fileViewFor, type FileViewRef } from './file-views'
import type { PluginManifest } from './types'

export const BUILTIN_FILE_VIEW_PLUGIN_ID = 'notemd.core'
export const OUTLINE_FILE_VIEW_ID = 'outline-note'

/**
 * Built-in surfaces use the same declarative matcher and presentation state as
 * plugin file views. The gate preserves the existing desktop/iOS and
 * case-insensitive suffix contract; once applicable, the declaration is
 * evaluated by the ordinary file-view matcher.
 */
export function builtinFileViewManifests(tab: Tab): PluginManifest[] {
  if (!isOutlineNoteTab(tab)) return []
  return [{
    id: BUILTIN_FILE_VIEW_PLUGIN_ID,
    name: 'Outline Note',
    version: '1',
    kind: 'builtin',
    binary: '',
    host_capabilities: [],
    i18n: {
      zh: { name: '笔记大纲' },
      ja: { name: 'アウトラインノート' },
      de: { name: 'Gliederungsnotiz' },
    },
    file_views: [{
      id: OUTLINE_FILE_VIEW_ID,
      entry: 'outline-note.html',
      icon: 'sparkle',
      priority: 1000,
      selectors: [{ file_name_patterns: ['*.note.md', '*.notes.md'] }],
    }],
  }]
}

export function builtinFileViewFor(tab: Tab): FileViewRef | null {
  const document = { path: tab.filePath.toLowerCase(), kind: tab.kind, content: tab.currentContent }
  return fileViewFor(document, builtinFileViewManifests(tab))
}

export function isBuiltinOutlineFileView(view: FileViewRef | null | undefined): boolean {
  return view?.pluginId === BUILTIN_FILE_VIEW_PLUGIN_ID && view.viewId === OUTLINE_FILE_VIEW_ID
}
