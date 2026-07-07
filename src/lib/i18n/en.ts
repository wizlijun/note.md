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
  'share.errPrefix': '❌ Share: {msg}',
  'share.actionFailed': '❌ Share: failed to {action}',
  'share.action.share': 'share',
  'share.action.unpublish': 'revoke share',
  'share.action.copyLink': 'copy link',
  'share.imageUpdated': '✅ Image updated (copied)',
  'share.imageShared': '✅ Image shared (copied)',
  'share.contentUpdated': '✅ Content updated (link copied)',
  'share.shared': '✅ Shared (copied)',
  'share.unpublished': '✅ Share revoked',
  'share.linkCopied': '✅ Link copied',
  'share.err.not_configured': 'Configure the Service URL and API Key in Preferences → Share first',
  'share.err.no_path': 'Save the file first',
  'share.err.empty_content': 'Content is empty',
  'share.err.network': 'Network error, please check your connection',
  'share.err.auth': 'Invalid API key, please check Preferences',
  'share.err.forbidden': 'Not allowed to revoke this share',
  'share.err.too_large': 'Document too large (25 MB limit)',
  'share.err.conflict': 'Slug conflict, please retry later',
  'share.err.unsupported': 'Unsupported image format',
  'share.err.server': 'Server busy, please retry later',
  'share.err.http': 'Request failed',
  'share.err.parse': 'Failed to parse server response',
  'share.err.corrupt_record': 'Local share record is corrupt',

  // Source-of-truth Vault (sotvault)
  'sotvault.revealFailed': '❌ Failed to open source folder',
  'sotvault.saveFirst': 'Please save the file before syncing to the Vault',
  'sotvault.synced': '✓ Synced to Vault',
  'sotvault.syncFailed': '❌ Failed to sync to Vault',
  'sotvault.sourceMovedOrDeleted': '⚠️ Vault: source file moved or deleted; cannot check for updates',
  'sotvault.askLocalChanged': 'This file is synced to the Vault and has changed since the last sync. Sync to the Vault now?',
  'sotvault.askSourceUpdated': 'The source file was updated. Sync it into the Vault?',
  'sotvault.syncTitle': 'Sync to Vault',
  'sotvault.conflictTitle': 'Vault conflict',
  'sotvault.conflictOverwrite': 'Both the source and the Vault copy were modified (conflict). Overwrite the Vault copy with the source?',
  'sotvault.conflictKeep': 'Keep the current Vault content and stop update prompts for this file?',
  'sotvault.updatedFromSource': '✓ Updated the Vault copy from the source',
  'sotvault.updateFailed': '❌ Failed to update the Vault copy',

  // Vault settings tab
  'vault.connected': '✓ Vault connected, repository cloned',
  'vault.err.keychain': '❌ Vault connection failed: Keychain bridge not ready (Keychain.swift not yet added to the Xcode target)',
  'vault.err.authConnect': '❌ Vault connection failed: PAT authentication failed — ensure the token has contents:read/write permission',
  'vault.err.notFoundConnect': '❌ Vault connection failed: repository not found or PAT lacks access',
  'vault.err.networkConnect': '❌ Vault connection failed: network error',
  'vault.err.generic': '❌ Vault connection failed: {error}',
  'vault.disconnectConfirm': 'Disconnecting the Vault will delete the local Vault copy and the PAT in the Keychain. The remote repo is unaffected. Continue?',
  'vault.disconnectTitle': 'Disconnect Vault',
  'vault.disconnected': '✓ Vault disconnected',
  'vault.disconnectFailed': '❌ Disconnect failed: {error}',
  'vault.statusLabel': 'Status:',
  'vault.syncing': 'Syncing…',
  'vault.cloning': 'Cloning…',
  'vault.lastSync': '✓ Last sync: {time}',
  'vault.unknownError': 'Unknown error',
  'vault.hasConflicts': '⚠️ Conflicting files',
  'vault.notConfigured': 'Not configured',
  'vault.syncNow': 'Sync now',
  'vault.disconnect': 'Disconnect Vault',
  'vault.remoteUrl': 'Remote URL',
  'vault.branch': 'Branch',
  'vault.pat': 'Personal Access Token',
  'vault.patConfigured': '✓ Configured',
  'vault.patUpdate': 'Update…',
  'vault.howToToken': '📖 How to generate a token',
  'vault.authorName': 'Author Name',
  'vault.authorEmail': 'Author Email',
  'vault.saving': 'Saving…',
  'vault.saveConfig': 'Save config',
  'vault.filesWarning': '⚠️ Do not modify or delete the Documents/Vault/ directory in the Files app, or the sync state will be corrupted.',

  // Vault sync
  'vault.syncedWithConflicts': '⚠️ Vault: sync complete; some local edits kept as .conflict copies',
  'vault.syncComplete': '✓ Vault sync complete',
  'vault.authFailed': '❌ Vault: authentication failed — update your PAT in Vault settings',
  'vault.networkError': '❌ Vault: network error',
  'vault.repoNotFound': '❌ Vault: repository not found or PAT lacks access',
  'vault.mergeFailed': '⚠️ Vault: auto-merge failed; skipped this time, will retry',

  // Plugin host
  'host.startFailed': '❌ {name}: failed to start',
  'host.noResponse': '{name}: no response ({seconds}s)',
  'host.abnormalExit': '❌ {name}: exited abnormally (code {code})',
  'host.protocolEmpty': '❌ {name}: protocol error (empty response)',
  'host.protocolError': '❌ {name}: protocol error',

  // Print
  'print.nothingToPrint': 'Nothing to print',
  'print.renderFailed': 'Print rendering failed',

  // Slash menu items
  'slash.filter.images': 'Images',
  'slash.filter.docs': 'Documents & files',
  'slash.image.label': 'Insert image…',
  'slash.image.desc': 'Choose an image file from your computer',
  'slash.doc.label': 'Insert document…',
  'slash.doc.desc': 'Choose a file to link as an attachment',
  'slash.h1.label': 'Heading 1',
  'slash.h1.desc': 'Top-level heading',
  'slash.h2.label': 'Heading 2',
  'slash.h2.desc': 'Second-level heading',
  'slash.h3.label': 'Heading 3',
  'slash.h3.desc': 'Third-level heading',
  'slash.quote.label': 'Quote',
  'slash.quote.desc': 'Block quote',
  'slash.code.label': 'Code block',
  'slash.code.desc': 'Code block with syntax highlighting',
  'slash.mermaid.label': 'Mermaid diagram',
  'slash.mermaid.desc': 'Flowchart, sequence, Gantt…',
  'slash.math.label': 'Math formula',
  'slash.math.desc': 'LaTeX math block',
  'slash.table.label': 'Table',
  'slash.table.desc': '3×3 editable table',
  'slash.spreadsheet.label': 'Spreadsheet',
  'slash.spreadsheet.desc': 'Editable spreadsheet (with formulas)',
  'slash.bullet.label': 'Bulleted list',
  'slash.bullet.desc': 'Unordered list',
  'slash.ordered.label': 'Numbered list',
  'slash.ordered.desc': 'Ordered list',
  'slash.task.label': 'Task list',
  'slash.task.desc': 'Checklist / to-do',
  'slash.hr.label': 'Divider',
  'slash.hr.desc': 'Horizontal rule',

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

  // Slash menu (empty state)
  'slashMenu.noMatches': 'No matches',

  // Find / replace
  'findReplace.find': 'Find',
  'findReplace.matchCase': 'Match case',
  'findReplace.wholeWord': 'Whole word',
  'findReplace.regex': 'Regular expression',
  'findReplace.previous': 'Previous',
  'findReplace.next': 'Next',
  'findReplace.replaceWith': 'Replace with…',
  'findReplace.replace': 'Replace',
  'findReplace.replaceAll': 'Replace all',
  'findReplace.replaceToggle': 'Replace ▾',

  // Spreadsheet context menu
  'spreadsheet.insertRowAbove': 'Insert row above',
  'spreadsheet.insertRowBelow': 'Insert row below',
  'spreadsheet.deleteRow': 'Delete row',
  'spreadsheet.insertColLeft': 'Insert column left',
  'spreadsheet.insertColRight': 'Insert column right',
  'spreadsheet.deleteCol': 'Delete column',
  'spreadsheet.clearSelection': 'Clear selection',

  // Image toolbar
  'imageToolbar.original': 'Original',
  'imageToolbar.originalSize': 'Original size',

  // Citations (block references)
  'citation.notFound': 'Citation not found',
  'citation.here': 'here',
  'citation.sameDoc': 'same document',
  'citation.jumpTitle': 'Jump to {target} #{blockid}',
  'citation.blockDeleted': 'Original block deleted (in generation {gen})',
  'citation.blockEdited': 'Original block edited; jumped to the current inherited block {id}',
  'citation.noBlockIds': 'Target document has no block ids (no yaml in cache; run Compute Blocks first)',

  // Plugin action failure
  'pluginAction.failed': '{name}: {type} failed',

  // Settings → Software update
  'settings.update.heading': 'Software update',
  'settings.update.upToDate': 'Up to date.',
  'settings.update.foundNew': 'Found new version v{version}',
  'settings.update.currentVersionLabel': 'Current version: ',
  'settings.update.lastChecked': 'Last checked: {time}',
  'settings.update.autoCheck': 'Automatically check for updates on launch (every 20 hours)',
  'settings.update.checking': 'Checking…',
  'settings.update.checkNow': 'Check for updates now',
  'settings.update.downloadInstall': 'Download and install v{version}',
  'settings.update.restartNow': 'Restart now to finish updating',
  'settings.update.downloading': 'Downloading:',
  'settings.update.notes': 'v{version} release notes',
  'settings.update.distNote': 'Updates are distributed via GitHub Releases; downloads are signature-verified with a built-in public key before install — only signed packages replace the .app.',

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

  // Update dialog
  'updateDialog.checking': 'Checking for updates…',
  'updateDialog.currentVersion': 'Current version: v{version}',
  'updateDialog.available': 'M↓ {version} available',
  'updateDialog.whatsNew': "What's new",
  'updateDialog.noNotes': 'No release notes.',
  'updateDialog.skip': 'Skip this version',
  'updateDialog.later': 'Later',
  'updateDialog.updateNow': 'Update now',
  'updateDialog.downloading': 'Downloading {version}…',
  'updateDialog.runInBackground': 'Run in background',
  'updateDialog.ready': 'Ready',
  'updateDialog.readyBody': 'M↓ {version} has been downloaded. Restart the app to finish updating.',
  'updateDialog.restartLater': 'Restart later',
  'updateDialog.restartNow': 'Restart now',
  'updateDialog.error': 'Update error',
  'updateDialog.unknownError': 'Unknown error',
  'updateDialog.upToDate': 'M↓ is up to date',

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

  // OpenClaw settings + devices
  'openclaw.heading': 'OpenClaw',
  'openclaw.connectMode': 'Connect mode',
  'openclaw.autoDetect': 'Auto-detect',
  'openclaw.modeHost': 'Host (local UDS)',
  'openclaw.modeRemote': 'Remote (via mdrelay)',
  'openclaw.socketPath': 'Socket path',
  'openclaw.accessToken': 'Access token',
  'openclaw.runToGenerate': "Run 'mdedit openclaw install' to generate",
  'openclaw.hide': 'Hide',
  'openclaw.show': 'Show',
  'openclaw.copy': 'Copy',
  'openclaw.copied': '✓ copied',
  'openclaw.copyFailed': 'copy failed',
  'openclaw.relayUrl': 'Relay URL',
  'openclaw.autoSync': 'Auto-sync before resolving chat links',
  'openclaw.devices': 'Devices',
  'openclaw.hostname': 'Hostname',
  'openclaw.lastSeen': 'Last seen',
  'openclaw.revoke': 'Revoke',
  'openclaw.forget': 'Forget',
  'openclaw.noPairedDevices': 'No paired devices yet.',
  'openclaw.addDevice': '+ Add device',

  // Theme import dialog
  'themeImport.title': 'Import Typora theme',
  'themeImport.noneFound': 'No Typora themes found in this zip.',
  'themeImport.detected': 'Detected {count} theme(s):',
  'themeImport.willOverwrite': '⚠ will overwrite existing',
  'themeImport.assetFolders': 'Asset folders:',
  'themeImport.errors': 'Errors:',
  'themeImport.overwriteExisting': 'Overwrite existing themes',
  'themeImport.importing': 'Importing…',
  'themeImport.import': 'Import',

  // Chat / pairing
  'chat.connectTitle': 'Connect to your OpenClaw',
  'chat.enterPairingCode': "Enter the pairing code shown on your host machine's M↓ settings.",
  'chat.pairingCode': 'Pairing code',
  'chat.deviceNameOptional': 'Device name (optional)',
  'chat.connecting': 'Connecting…',
  'chat.pair': 'Pair',
  'chat.addDevice': 'Add a new device',
  'chat.retry': 'Retry',
  'chat.generatingCode': 'Generating pairing code…',
  'chat.expiresIn': 'Expires in {time}',
  'chat.typeToOpenClaw': 'Type to OpenClaw…',
  'chat.send': 'Send',
} as const

export type Messages = typeof en
