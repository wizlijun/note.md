"""Pure checks for frozen Home source and actual Mach-O resource witnesses."""
from pathlib import Path
import hashlib
import json
import os
import re


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify_frozen_sources(paths, accepted_read, frozen_read):
    assert paths and len(paths) == len(set(paths))
    report = {}
    for path in paths:
        accepted, frozen = accepted_read(path), frozen_read(path)
        assert accepted == frozen, 'Frozen implementation differs from accepted f1625169: ' + path
        report[path] = {'acceptedSha256': sha(accepted), 'frozenSha256': sha(frozen), 'byteIdentical': True}
    return report


def verify_home_source(read):
    checks = {
        'src/components/HomeApps.svelte': ['<AppDirectory ', 'shortcutSlots(homeAppsStore.data, eligible)', 'pinHomeApp(app.id, slot)', 'moveHomeApp(', "invoke<InstalledV2[]>('plugin_market_installed')", 'home-context-menu menu-panel', 'homeApps.commonFeatures', 'home-grid home-functions-grid', 'data-home-action="new-note"', 'data-home-action="new-canvas"', 'data-home-action="open-file"', 'data-home-action="all-apps"'],
        'src/components/AppDirectory.svelte': ['PLUGIN_CATEGORY_ORDER', 'data-target-slot', 'type="search"', 'declared-commands', 'homeApps.pdfGuide'],
        'src/lib/home-apps/model.ts': ['const SLOT_COUNT = 8', 'pins: Array(SLOT_COUNT).fill(null)', 'slot >= SLOT_COUNT', 'data.pins.map((id) => id ?? recommendations[index++] ?? null)'],
        'src/lib/home-apps/store.svelte.ts': ["Store.load('home-apps.json', { autoSave: false, defaults: {} })", 'await storage!.save()', 'homeAppsStore.data = next', 'writeQueue = operation.catch(() => {})'],
        'src/components/HomeContent.svelte': ['const COLLAPSED_ROWS = 3', 'homeContent.new', 'homeContent.continue', 'homeContent.showAll', 'section.items.slice(0, COLLAPSED_ROWS)', 'content-preview', 'dismissHomeContent(section.kind, item.path)', 'line-clamp:2'],
        'src/lib/home-content/model.ts': ['READ_MS = 30_000', 'CONTINUE_MS = 60_000', 'PROCESS_DIRS', 'CONTROL_NAMES', "list === 'new'", 'dismissedContinueAt', 'preview'],
        'src/lib/home-content/store.svelte.ts': ["Store.load('home-content.json'", ">('home_content_catalog'", "invoke('update_latest_menu'", "invoke('update_recent_menu'", 'Infinity, unavailable', 'recordHomeEdit', 'renameHomeContent'],
        'src-tauri/src/home_content.rs': ['const HEADER_BYTES: u64 = 16 * 1024', 'pub async fn home_content_catalog', 'root_guard::check', 'fn body_preview', 'text.chars().take(179)', 'preview: Option<String>'],
        'src/components/VaultOverview.svelte': ['let expanded = $state(false)', 'aria-expanded={expanded}', 'stats.documents.toLocaleString', 'formatContentBytes(stats.bytes)', 'compact'],
        'src/components/EmptyState.svelte': ['<HomeApps />', '<HomeContent />', '<VaultOverview compact />', 'home-ai', 'homeAi.empty', 'home-footer', 'homeApps.allSettings'],
        'src/components/HomeDocumentHost.svelte': ['let retained = $state<Tab | null>(null)', 'hidden={!current} inert={!current}', '{@render children(document)}'],
        'src/styles/home-apps.css': ['.home-grid.home-functions-grid { grid-template-columns:repeat(6,minmax(0,1fr))', '@media(prefers-color-scheme:dark)', '#243744', '#203c37', '#3d3222', '@container(max-width:580px)'],
        'src/lib/editor-bridge.ts': ['recordEditorDelta(delta)', 'delta.userEdit !== false', 'recordHomeEdit(file.tab.filePath, sotvaultStore.vaultRoot)', 'onInputBlocked: reportFileInputBlocked'],
        'src/editor-kit-v2/file-main.ts': ['FileInputBlockedError', 'FILE_INPUT_WAIT_MS', 'onInputBlocked', 'composition-interrupted'],
        'src/lib/file-input-feedback.ts': ['editorInput.richComposing', 'editorInput.sourcePending', 'editorInput.annotationPending', 'autoDismissMs: 0'],
        'src/App.svelte': ['await flushHomeContent().catch', 'reportFileInputBlocked(error)', 'open-continue:', 'open-history:'],
        'src/lib/project-share/browser.ts': ['notemd://share/open?u='],
    }
    for path, tokens in checks.items():
        text = read(path)
        for token in tokens:
            assert token in text, 'Missing current source invariant: ' + path + ':' + token
    layout=read('src/components/EmptyState.svelte')
    assert layout.index('<HomeApps />') < layout.index('<HomeContent />') < layout.index('<section class="home-ai"') < layout.index('<footer class="home-footer"')
    ai=layout.split('<section class="home-ai"',1)[1].split('</section>',1)[0]
    assert '<button' not in ai and 'onclick=' not in ai and "{t('homeAi.empty')}" in ai, 'AI layout must remain a static empty section'
    return checks


JS_ROLES = {
    'HomeApps-two-rows-combined': ['home-apps', 'data-home-slot', 'homeApps.commonFeatures', 'homeApps.allApps', 'home-grid home-functions-grid', 'data-home-action', 'new-note', 'new-canvas', 'open-file', 'all-apps', 'home-context-menu menu-panel'],
    'AppDirectory': ['app-directory', 'data-target-slot', 'homeApps.directory', 'homeApps.choosePosition', 'declared-commands'],
    'eight-slots-pins-model-store': ['home-apps.json', 'Shortcut slot must be between 0 and 7', 'App is already pinned; use movePin', 'Auto app move requires its visible source slot', 'pins', 'snapshot'],
    'document-preview-dismiss-show-all': ['content-columns', 'content-preview', 'homeContent.new', 'homeContent.continue', 'homeContent.showAll', 'content-dismiss', 'home-content-list-'],
    'home-content-state-and-menus': ['home-content.json', 'home_content_catalog', 'update_latest_menu', 'update_recent_menu'],
    'Vault-collapsed-details': ['vault-name', 'aria-expanded', 'vaultOverview.showDetails', 'vaultOverview.hideDetails', 'path-row', 'vaultOverview.documents', 'vaultOverview.contentSize'],
    'home-static-AI-and-footer': ['home-ai', 'homeAi.title', 'homeAi.empty', 'home-footer', 'homeApps.allSettings'],
    'input-blocked-feedback': ['editorInput.richComposing', 'editorInput.sourceComposing', 'editorInput.sourcePending', 'editorInput.annotationPending', '[file-input] operation blocked:'],
    'shared-readonly-open-in-app': ['notemd://share/open?u='],
    'input-blocked-session': ['rich-composing', 'source-pending', 'annotation-pending', 'composition-interrupted', 'FileInputBlockedError'],
}
CSS_ROLES = {
    'HomeApps-dark-and-responsive': ['.home-grid.home-functions-grid', 'repeat(6,minmax(0,1fr))', 'prefers-color-scheme:dark', '#243744', '#203c37', '#3d3222'],
    'AppDirectory-layout': ['.app-directory', '.position-grid', '.directory-list'],
    'Vault-name-and-metrics': ['.vault-name', '.metrics'],
    'documents-previews-and-columns': ['.content-columns', '.content-preview', '.content-dismiss', 'line-clamp:2'],
    'home-AI-and-status-footer': ['.home-ai', '.home-footer', '.ai-empty'],
}


def verify_home_resources(js_assets, css_assets, embedded_hashes):
    witnesses = []
    for kind, roles, assets in [('javascript', JS_ROLES, js_assets), ('css', CSS_ROLES, css_assets)]:
        for role, tokens in roles.items():
            candidates = [(path, text) for path, text in assets.items() if not path.name.startswith('share-editor') and all(token in text for token in tokens)]
            assert candidates, 'Missing complete Home compiled role: ' + role
            rows = []
            for path, text in candidates:
                digest = sha(path.read_bytes())
                assert digest in embedded_hashes, 'Home compiled role absent from actual signed Mach-O: ' + str(path)
                rows.append({'asset': path.name, 'sha256': digest, 'bytes': path.stat().st_size})
            witnesses.append({'role': role, 'kind': kind, 'tokens': tokens, 'wholeEmbeddedAssets': rows})
    model_candidates = [(path, text) for path, text in js_assets.items() if not path.name.startswith('share-editor') and all(token in text for token in JS_ROLES['eight-slots-pins-model-store'])]
    slot_proof = []
    for path, text in model_candidates:
        for match in re.finditer(r'pins:Array\(([$\w]+)\)\.fill\(null\)', text):
            symbol = match.group(1)
            assert re.search(r'(?:const |let |var |,)' + re.escape(symbol) + r'=8(?:[,;])', text), 'Compiled slot default is not bound to eight'
            assert re.search(r'>=' + re.escape(symbol) + r'\)', text), 'Compiled slot upper-bound does not use eight-slot constant'
            slot_proof.append({'asset': path.name, 'constant': symbol, 'default': match.group(), 'value': 8})
    assert slot_proof, 'Missing compiled eight-slot array/constant binding'
    collapsed_proof = []
    for path, text in js_assets.items():
        if path.name.startswith('share-editor') or not all(token in text for token in JS_ROLES['document-preview-dismiss-show-all']):
            continue
        # Bind the local constant to the adjacent New/Continue derived sections,
        # then require both the Show All threshold and the list slice to use it.
        pattern = r'const ([$\w]+)=3,[$\w]+=[$\w]+\(\(\)=>\[\{kind:"new",title:[$\w]+\("homeContent\.new"\)'
        for match in re.finditer(pattern, text):
            symbol = match.group(1)
            component = text[match.start():match.end()+12000]
            assert re.search(r'\.items\.length>' + re.escape(symbol) + r'&&', component), 'Show All threshold does not use the three-row constant'
            assert re.search(r'\.items\.slice\(0,' + re.escape(symbol) + r'\)', component), 'Collapsed list does not use the three-row constant'
            collapsed_proof.append({'asset': path.name, 'constant': symbol, 'value': 3, 'binding': match.group(), 'thresholdAndSliceUseConstant': True})
    assert collapsed_proof, 'Missing compiled three-row threshold/slice binding'
    return {'compiledSlotBindings': slot_proof, 'compiledCollapsedRows': collapsed_proof, 'compiledRoles': witnesses, 'proof': 'Frozen implementation files are byte-identical to the accepted source. Every complete witness module/CSS is byte-hashed and bound to a complete Brotli resource present in the actual signed Mach-O, with feature-token witnesses. Source-to-resource provenance relies on the recorded clean build and release log; these checks are not an independent reproducible rebuild or GUI/runtime proof.'}


def app_manifest(app):
    manifest = {}
    for path in app.rglob('*'):
        relative = str(path.relative_to(app))
        if path.is_symlink():
            manifest[relative] = {'type': 'symlink', 'target': os.readlink(path)}
        elif path.is_file():
            manifest[relative] = {'type': 'file', 'mode': path.stat().st_mode & 0o777, 'bytes': path.stat().st_size, 'sha256': sha(path.read_bytes())}
    assert manifest
    return manifest


def verify_notary(log, codesign_details, label, stapled_sha=None):
    assert label in ('app', 'dmg')
    assert log['status'] == 'Accepted' and log['statusCode'] == 0 and log['issues'] is None
    assert re.fullmatch('[0-9a-f-]{36}', log['jobId'])
    assert re.fullmatch('[0-9a-f]{64}', log['sha256'])
    match = re.search(r'^CDHash=([0-9a-f]{40})$', codesign_details, re.M)
    assert match, 'Missing actual codesign CDHash'
    digest = match.group(1)
    tickets = log['ticketContents']
    if label == 'app':
        bound = [t for t in tickets if t['path'].endswith('/note.md.app') or t['path'].endswith('/note.md.app/Contents/MacOS/notemd')]
        assert len(bound) == 2 and all(t['cdhash'] == digest and t.get('arch') == 'arm64' and t['digestAlgorithm'] == 'SHA-256' for t in bound), 'App CDHash not bound to Apple Accepted ticket'
    else:
        bound = [t for t in tickets if t['path'] == log['archiveFilename']]
        assert len(bound) == 1 and bound[0]['cdhash'] == digest and bound[0]['digestAlgorithm'] == 'SHA-256', 'DMG CDHash not bound to Apple Accepted ticket'
    return {'submissionId': log['jobId'], 'status': 'Accepted', label+'CDHash': digest, 'ticketMatches'+label.title(): True, 'appleSubmittedArchiveSha256': log['sha256'], 'stapledDownloadedSha256': stapled_sha, 'shaBoundary': 'Apple archive SHA is pre-staple and is not asserted equal to the post-staple download SHA; actual CDHash is bound to this Accepted ticket.', 'tickets': tickets}


def verify_app_archive_binding(capture, build_log, apple_log, expected_job_id):
    assert re.fullmatch('[0-9a-f-]{36}', expected_job_id), 'Invalid explicit current App job ID'
    assert apple_log['jobId'] == expected_job_id, 'Apple log jobId differs from explicit current App submission'
    path = capture['path_observed_in_build_log']
    assert path.startswith('/var/') and path.endswith('/note.md.zip') and path in build_log
    assert isinstance(capture['bytes'], int) and capture['bytes'] > 0
    assert re.fullmatch('[0-9a-f]{64}', capture['sha256'])
    assert capture['sha256'] == apple_log['sha256'], 'Apple notarization archive SHA differs from the exact current submitted zip capture'
    assert apple_log['archiveFilename'] == 'note.md.zip'
    return {'capturedAppZipSha256': capture['sha256'], 'appleSubmittedArchiveSha256': apple_log['sha256'], 'byteShaMatches': True, 'submissionId': apple_log['jobId'], 'buildLogArchivePath': path, 'capturedAt': capture['captured_at'], 'boundary': 'The current build-log zip path and captured pre-staple zip SHA bind this Apple job to the submitted App archive. This SHA is not asserted equal to a post-staple App, tar or DMG SHA.'}
