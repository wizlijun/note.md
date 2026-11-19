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
        assert accepted == frozen, 'Frozen implementation differs from accepted df353a18: ' + path
        report[path] = {'acceptedSha256': sha(accepted), 'frozenSha256': sha(frozen), 'byteIdentical': True}
    return report


def verify_home_source(read):
    checks = {
        'src/components/HomeApps.svelte': ['<AppDirectory ', 'shortcutSlots(homeAppsStore.data, eligible)', 'pinHomeApp(app.id, slot)', 'moveHomeApp(', "invoke<InstalledV2[]>('plugin_market_installed')", 'home-context-menu menu-panel'],
        'src/components/AppDirectory.svelte': ['PLUGIN_CATEGORY_ORDER', 'data-target-slot', 'type="search"', 'declared-commands', 'homeApps.pdfGuide'],
        'src/lib/home-apps/model.ts': ['const SLOT_COUNT = 8', 'pins: Array(SLOT_COUNT).fill(null)', 'slot >= SLOT_COUNT', 'data.pins.map((id) => id ?? recommendations[index++] ?? null)'],
        'src/lib/home-apps/store.svelte.ts': ["Store.load('home-apps.json', { autoSave: false, defaults: {} })", 'await storage!.save()', 'homeAppsStore.data = next', 'writeQueue = operation.catch(() => {})'],
        'src/components/VaultOverview.svelte': ['let expanded = $state(false)', 'aria-expanded={expanded}', '{#if expanded}<div class="path-row">', 'stats.documents.toLocaleString', 'formatContentBytes(stats.bytes)'],
        'src/components/EmptyState.svelte': ['<HomeApps />', '<VaultOverview />', 'home-create home-grid', 'homeApps.allSettings'],
        'src/components/HomeDocumentHost.svelte': ['let retained = $state<Tab | null>(null)', 'hidden={!current} inert={!current}', '{@render children(document)}'],
        'src/styles/home-apps.css': ['grid-template-columns:repeat(4,minmax(0,1fr))', '@media(prefers-color-scheme:dark)', '#243744', '#203c37', '#3d3222', '@container(max-width:420px)'],
    }
    for path, tokens in checks.items():
        text = read(path)
        for token in tokens:
            assert token in text, 'Missing Home source invariant: ' + path + ':' + token
    return checks


JS_ROLES = {
    'HomeApps': ['home-apps', 'data-home-slot', 'homeApps.shortcuts', 'homeApps.allApps', 'home-context-menu menu-panel'],
    'AppDirectory': ['app-directory', 'data-target-slot', 'homeApps.directory', 'homeApps.choosePosition', 'declared-commands'],
    'eight-slots-pins-model-store': ['home-apps.json', 'Shortcut slot must be between 0 and 7', 'App is already pinned; use movePin', 'Auto app move requires its visible source slot', 'pins', 'snapshot'],
    'Vault-collapsed-details': ['vault-name', 'aria-expanded', 'vaultOverview.showDetails', 'vaultOverview.hideDetails', 'path-row', 'vaultOverview.documents', 'vaultOverview.contentSize'],
    'home-create-and-settings': ['home-create home-grid', 'homeApps.newNote', 'homeApps.newCanvas', 'homeApps.openFile', 'homeApps.allSettings'],
}
CSS_ROLES = {
    'HomeApps-dark-and-responsive': ['.home-grid', 'repeat(4,minmax(0,1fr))', 'prefers-color-scheme:dark', '#243744', '#203c37', '#3d3222', 'repeat(2,minmax(0,1fr))'],
    'AppDirectory-layout': ['.app-directory', '.position-grid', '.directory-list'],
    'Vault-name-and-metrics': ['.vault-name', '.metrics'],
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
    return {'compiledSlotBindings': slot_proof, 'compiledRoles': witnesses, 'proof': 'Frozen implementation files are byte-identical to the accepted source. Every complete witness module/CSS is byte-hashed and bound to a complete Brotli resource present in the actual signed Mach-O, with feature-token witnesses. Source-to-resource provenance relies on the recorded clean build and release log; these checks are not an independent reproducible rebuild or GUI/runtime proof.'}


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


def verify_app_archive_binding(capture, build_log, apple_log):
    path = capture['path_observed_in_build_log']
    assert path.startswith('/var/') and path.endswith('/note.md.zip') and path in build_log
    assert isinstance(capture['bytes'], int) and capture['bytes'] > 0
    assert re.fullmatch('[0-9a-f]{64}', capture['sha256'])
    assert capture['sha256'] == apple_log['sha256'], 'Apple notarization archive SHA differs from the exact current submitted zip capture'
    assert apple_log['archiveFilename'] == 'note.md.zip'
    return {'capturedAppZipSha256': capture['sha256'], 'appleSubmittedArchiveSha256': apple_log['sha256'], 'byteShaMatches': True, 'submissionId': apple_log['jobId'], 'buildLogArchivePath': path, 'capturedAt': capture['captured_at'], 'boundary': 'The current build-log zip path and captured pre-staple zip SHA bind this Apple job to the submitted App archive. This SHA is not asserted equal to a post-staple App, tar or DMG SHA.'}
