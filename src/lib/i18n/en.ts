// English base catalog — the source of truth for every user-facing string.
//
// Keys are flat, dot-namespaced by UI area (e.g. `folderView.reveal`). Using a
// flat object (not nested) keeps `t()`'s keys type-safe via `keyof Messages`
// and makes lookup a single property read. `{name}` placeholders are filled by
// `t(key, params)`.
//
// To add another language, create a sibling catalog (e.g. `zh.ts`) typed as
// `Partial<Messages>` and register it in `store.svelte.ts`.
export const en = {
  // Generic / shared
  'common.cancel': 'Cancel',
  'common.ok': 'OK',
  'common.close': 'Close',
  'common.dismiss': 'Dismiss',
  'common.saveAs': 'Save as…',

  // Settings
  'settings.language': 'Language',

  // Editor mode toggle
  'mode.editorMode': 'Editor mode',
  'mode.previewRich': 'Preview (rich)',
  'mode.source': 'Source (Cmd+/)',

  // Mobile toolbar
  'toolbar.openMenu': 'Open menu',
  'toolbar.toggleMode': 'Toggle source/rich',
  'toolbar.more': 'More',
  'toolbar.save': 'Save',
  'toolbar.saveAs': 'Save As…',
  'toolbar.share': 'Share',
  'toolbar.settings': 'Settings',

  // HTML preview
  'htmlPreview.title': 'HTML preview',

  // Empty state
  'emptyState.hint': 'Drop a .md file, or',
  'emptyState.new': 'New (⌘N)',
  'emptyState.open': 'Open… (⌘O)',

  // Toast
  'toast.showDetails': 'Show details',
  'toast.collapse': 'Collapse',
  'toast.details': 'Details',
  'toast.autoClose': 'Auto-close',

  // Synced-from-source banner
  'syncOrigin.synced': '📎 Synced from source:',
  'syncOrigin.revealTitle': 'Reveal source location',
  'syncOrigin.openSourceDir': 'Open source folder',

  // External-change banner
  'externalChange.modified': '"{title}" was modified by another application.',
  'externalChange.deleted': '"{title}" was deleted on disk.',
  'externalChange.reload': 'Reload from disk',
  'externalChange.overwrite': 'Overwrite with my changes',
  'externalChange.recreate': 'Recreate on Save (⌘S)',
  'externalChange.closeTab': 'Close tab',

  // Sync-to-Vault offer banner
  'syncToVault.offer': '💡 This file is outside the Vault. Syncing to the Vault keeps a copy there — auto-backed-up via git, synced across devices, and refreshable in one click when the source updates.',
  'syncToVault.sync': 'Sync to Vault',

  // Update banner
  'updateBanner.available': '✨ M↓ {version} available',
  'updateBanner.viewDetails': 'View details',
  'updateBanner.downloading': 'Downloading {version}…',
  'updateBanner.showProgress': 'Show progress',
  'updateBanner.ready': '✅ {version} downloaded — restart to finish updating',
  'updateBanner.restart': 'Restart…',

  // Relative time
  'time.never': 'Never',
  'time.justNow': 'Just now',
  'time.minutesAgo': '{n} min ago',
  'time.hoursAgo': '{n} h ago',
  'time.daysAgo': '{n} d ago',

  // Folder view
  'folderView.parentFolder': 'Parent folder',
  'folderView.find': 'Find',
  'folderView.refresh': 'Refresh',
  'folderView.hide': 'Hide Folder View',
  'folderView.clearFilter': 'Clear filter',
  'folderView.filterPlaceholder': 'Filter (regex)…',
  'folderView.noMatches': 'No matches',
  'folderView.emptyFolder': 'Empty folder',
  'folderView.noFolder': 'No folder',
  'folderView.reveal': 'Reveal in Finder',
} as const

export type Messages = typeof en
