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

  // CLI (`mdedit`) install/uninstall
  'cli.installTitle': "Install 'mdedit' Command",
  'cli.installPrompt':
    "Install the 'mdedit' command to your PATH?\n\n" +
    "Once installed you can call M↓'s features from any terminal or script:\n" +
    '  • mdedit -s draft.md   Publish via the Share plugin and print the URL\n' +
    '  • mdedit help          Show all commands\n' +
    '  • mdedit plugin list   List plugins\n\n' +
    "You can manage this any time from Help → Install/Uninstall 'mdedit' Command.",
  'cli.installInto': "Install 'mdedit' into {dir}?",
  'cli.installed': "'mdedit' installed at {dir}",
  'cli.installFailed': 'Install failed: {error}',
  'cli.uninstalled': "'mdedit' uninstalled from {dir}",
  'cli.uninstallFailed': 'Uninstall failed: {error}',
  'cli.notInstalled': "'mdedit' is not installed",

  // Share
  'share.docTooLarge': '❌ {name}: document too large ({mb} MB / 25 MB limit)',
  'share.internalError': '❌ {name}: internal error',

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

  // Drawer / tab bar
  'drawer.closeMenu': 'Close menu',
  'tabBar.modified': 'modified',

  // Plugins settings
  'plugins.restartNote': 'Changes take effect after restarting M↓',

  // Vault browser
  'vaultBrowser.syncNow': 'Sync now',
  'vaultBrowser.notConfigured': 'No Vault configured.',
  'vaultBrowser.goConfigure': 'Go to Settings → Vault to configure a repo.',
  'vaultBrowser.up': '‹ Up',
  'vaultBrowser.empty': 'Vault is empty',

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
