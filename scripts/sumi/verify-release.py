#!/usr/bin/env python3
"""Read-only Sumi release gate. Never build, launch, install, sign or publish."""
import argparse
import base64
import hashlib
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import tarfile
import subprocess
import sys
sys.dont_write_bytecode = True
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
VERSION = '6.1108.4'
PLUGIN_VERSION = '0.1.3'
SOURCES = ['src/components/NativeFileView.svelte', 'src/components/SumiRecovery.svelte',
           'src/lib/sumi/session.ts', 'src/lib/sumi/recovery.ts', 'src/App.svelte',
           'src-tauri/src/sumi/mod.rs', 'src-tauri/src/sumi/export.rs',
           'src-tauri/src/sumi/recovery.rs', 'src-tauri/src/sumi/external.rs',
           'src-tauri/src/sumi/fonts.rs',
           'src-tauri/src/plugin_runtime/market.rs', 'src-tauri/src/app_dirs.rs',
           'tauri-plugin-native-editor/native/editor.m', 'tauri-plugin-native-editor/src/lib.rs',
           'tauri-plugin-native-editor/Cargo.toml', 'tauri-plugin-native-editor/build.rs',
           'plugins-src/write/src/main.ts', 'plugins-src/write/manifest.v2.json',
           'src-tauri/resources/sumi/manifest.json']


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args], stderr=subprocess.PIPE)


def source(commit, path):
    return git('show', f'{commit}:{path}')


def helper(path):
    spec = importlib.util.spec_from_file_location('candidate_checks', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def manifest_identity(value):
    require(value.get('id') == 'notemd.sumi' and value.get('version') == PLUGIN_VERSION, 'Wrong plugin identity/version')
    require(value.get('manifest_version') == 2 and value.get('ui') == 'ui/', 'Wrong plugin layout')
    require('editor.native' in value.get('capabilities', []), 'Native capability missing')
    require(any(v.get('surface') == 'native-editor' for v in value.get('contributes', {}).get('file_views', [])), 'Native file view missing')


def zip_files(path):
    result = {}
    with zipfile.ZipFile(path) as archive:
        require(sum(i.file_size for i in archive.infolist()) <= 32*1024*1024, 'Oversized plugin package')
        for item in archive.infolist():
            name = item.filename
            require(not name.startswith('/') and '\\' not in name and '..' not in PurePosixPath(name).parts, 'Unsafe package path')
            require(not stat.S_ISLNK(item.external_attr >> 16), 'Package symlink rejected')
            if item.is_dir():
                continue
            require(name not in result, 'Duplicate package member')
            result[name] = archive.read(item)
    return result


def verify_plugin_files(files, frozen):
    require(set(files) == set(frozen), 'Plugin package inventory differs from frozen UI/manifest')
    for name, raw in files.items():
        reject_font_path(name)
        require(sha(raw) == frozen[name], 'Plugin package bytes changed: '+name)
    manifest_identity(json.loads(files['manifest.json']))


FONT_CASCADES = {'Sumi Plex': ['IBMPlexMono-Light', 'IBMPlexSansSC-Light'], 'Sumi WenKai': ['LXGWWenKaiMonoLite-Regular'], 'Sumi Zhaohua': ['ZhaohuaTypeWriter-Light'], 'Sumi Youcha': ['YouchaSanz-Light'], 'Sumi Fangsong': ['ZhuqueFangsong-Regular'], 'Sumi CRT': ['Unifont']}
FONT_ASSETS = {
    'IBMPlexMono-Light.ttf',
    'IBMPlexMono-OFL.txt',
    'IBMPlexSansSC-LICENSE.txt',
    'IBMPlexSansSC-Light.otf',
    'LXGWWenKaiMonoLite-OFL.txt',
    'LXGWWenKaiMonoLite-Regular.ttf',
    'TerryWang-Official-License.json',
    'TerryWang-Typewriter-LICENSE.txt',
    'TerryWang-Typewriter-PROVENANCE.json',
    'YouchaSanz.ttf',
    'ZhaohuaTypeWriter.ttf',
    'ZhuqueFangsong-LICENSE.txt',
    'ZhuqueFangsong-Regular.ttf',
    'Unifont-18.0.01.otf',
    'Unifont-OFL.txt',
    'CRT-PROVENANCE.json',
}

FONT_EXTENSIONS = {'.ttf', '.otf', '.woff', '.woff2', '.ttc', '.otc'}
FONT_FACES = {
    'IBMPlexMono-Light.ttf': 'IBMPlexMono-Light',
    'IBMPlexSansSC-Light.otf': 'IBMPlexSansSC-Light',
    'LXGWWenKaiMonoLite-Regular.ttf': 'LXGWWenKaiMonoLite-Regular',
    'ZhaohuaTypeWriter.ttf': 'ZhaohuaTypeWriter-Light',
    'YouchaSanz.ttf': 'YouchaSanz-Light',
    'ZhuqueFangsong-Regular.ttf': 'ZhuqueFangsong-Regular',
    'Unifont-18.0.01.otf': 'Unifont',
}
BUNDLED_FONT_METADATA = FONT_ASSETS - FONT_FACES.keys()


def font_manifest(manifest_raw):
    manifest = json.loads(manifest_raw)
    require(manifest.get('schema') == 2 and manifest.get('default_alias') == 'Sumi Plex', 'Wrong font manifest/default alias')
    require(manifest.get('cascades') == FONT_CASCADES, 'Wrong selected font cascades or exact faces')
    assets = manifest['assets']
    require({a['file'] for a in assets} == FONT_ASSETS and len(assets) == len(FONT_ASSETS), 'Incomplete font/license/provenance manifest')
    for asset in assets:
        name = asset['file']
        require(type(asset.get('size')) is int and asset['size'] > 0, 'Invalid asset size: '+name)
        require(re.fullmatch('[0-9a-f]{64}', asset.get('sha256', '')) and asset['sha256'] != '0'*64, 'Invalid asset digest: '+name)
        if name in FONT_FACES:
            require(asset.get('postscript') == FONT_FACES[name], 'Wrong exact font face: '+name)
            require(isinstance(asset.get('license'), str) and asset['license'], 'Font license missing: '+name)
            require(re.fullmatch(r'https://[^/\s?#]+/[^\s#]+', asset.get('url', '')), 'Font download URL missing/unsafe: '+name)
        else:
            require(asset['size'] <= 1024*1024, 'Oversized bundled font metadata: '+name)
    zhuque = next(a for a in assets if a['file'] == 'ZhuqueFangsong-Regular.ttf')
    require(type(zhuque.get('archive_size')) is int and zhuque['archive_size'] > 0, 'Zhuque archive size missing')
    require(re.fullmatch('[0-9a-f]{64}', zhuque.get('archive_sha256', '')) and zhuque['archive_sha256'] != '0'*64, 'Zhuque archive digest missing')
    require(zhuque['url'].endswith('.zip'), 'Zhuque archive URL mismatch')
    require(len(manifest_raw) <= 1024*1024, 'Oversized font catalog')
    return manifest


def reject_font_path(name):
    require(not any(PurePosixPath(part).suffix.lower() in FONT_EXTENSIONS for part in PurePosixPath(name).parts), 'Font payload forbidden in thin distribution: '+name)


def no_bundled_fonts(root):
    for path in root.rglob('*'):
        reject_font_path(path.relative_to(root).as_posix())


def font_source_files(commit, manifest_raw):
    result = {'frozen_metadata': {}, 'local_development_fonts': {}, 'unavailable_local_fonts': []}
    for asset in font_manifest(manifest_raw)['assets']:
        name = asset['file']
        relative = 'src-tauri/resources/sumi/'+name
        if name in FONT_FACES:
            # Font binaries are intentionally gitignored. The frozen catalog
            # authenticates downloads; a thin release need not retain local fonts.
            path = ROOT/relative
            if not path.exists() and not path.is_symlink():
                result['unavailable_local_fonts'].append(name)
                continue
            require(path.is_file() and not path.is_symlink(), 'Invalid local development font: '+name)
            raw = path.read_bytes()
            group = 'local_development_fonts'
        else:
            raw = source(commit, relative)
            group = 'frozen_metadata'
        require(len(raw) == asset['size'] and sha(raw) == asset['sha256'], 'Font/catalog source mismatch: '+name)
        result[group][name] = sha(raw)
    return result


def font_files(folder, manifest_raw):
    manifest = font_manifest(manifest_raw)
    require(folder.is_dir() and not folder.is_symlink(), 'Invalid bundled metadata folder')
    require({p.name for p in folder.iterdir()} == BUNDLED_FONT_METADATA | {'manifest.json'}, 'Unexpected, missing or obsolete bundled font resource')
    for path in folder.iterdir():
        require(path.is_file() and not path.is_symlink(), 'Bundled metadata must be a regular file: '+path.name)
    require((folder/'manifest.json').read_bytes() == manifest_raw, 'Bundled font manifest differs from frozen source')
    result = {}
    for asset in manifest['assets']:
        if asset['file'] not in BUNDLED_FONT_METADATA:
            continue
        raw = (folder/asset['file']).read_bytes()
        require(len(raw) == asset['size'] and sha(raw) == asset['sha256'], 'Font metadata mismatch: '+asset['file'])
        result[asset['file']] = sha(raw)
    return result


def updater_resources(archive, expected_resources):
    members = archive.getmembers()
    prefix = 'note.md.app/Contents/Resources/resources/sumi/'
    actual = []
    for member in members:
        name = member.name.removeprefix('./')
        reject_font_path(name)
        if name.startswith(prefix) and name != prefix:
            require(member.isfile(), 'Updater metadata must be a regular file: '+name)
            actual.append(name.removeprefix('note.md.app/'))
    expected_names = {n for n in expected_resources if n.startswith('Contents/Resources/resources/sumi/')}
    require(len(actual) == len(expected_names) and set(actual) == expected_names, 'Updater font metadata inventory differs')
    for relative, expected in expected_resources.items():
        entries = [m for m in members if m.name.removeprefix('./') == 'note.md.app/'+relative]
        require(len(entries) == 1 and entries[0].isfile() and entries[0].size == len(expected), 'Updater resource inventory mismatch: '+relative)
        with archive.extractfile(entries[0]) as stream:
            require(stream.read() == expected, 'Updater resource mismatch: '+relative)


def native_evidence(libraries, objc):
    require(not re.search(r'(?i)(?:Qt(?:Core|Gui|Widgets|[456])|/Qt[^/]*\.framework)', libraries), 'Unexpected Qt linkage')
    for framework in ['AppKit.framework', 'CoreText.framework']:
        require(framework in libraries, 'Missing native framework '+framework)
    for name in ['SumiTextView', 'SumiEditor']:
        require(name in objc, 'Missing linked Objective-C native bridge class '+name)


def verify_architecture(actual, expected):
    require(expected in ('arm64', 'x86_64'), 'Unsupported release architecture')
    require(actual == expected, 'Expected thin '+expected+' release; lipo reported '+actual)


def freeze(args):
    commit = git('rev-parse', args.expected_source+'^{commit}').decode().strip()
    require(commit == args.expected_source, 'Use exact frozen 40-character commit')
    raw = source(commit, 'plugins-src/write/manifest.v2.json')
    manifest_identity(json.loads(raw))
    files = {'manifest.json': sha(raw)}
    for path in sorted(args.plugin_ui.rglob('*')):
        reject_font_path(path.relative_to(args.plugin_ui).as_posix())
        if path.is_file():
            require(not path.is_symlink(), 'Plugin UI symlink')
            files['ui/'+path.relative_to(args.plugin_ui).as_posix()] = sha(path.read_bytes())
    require('ui/index.html' in files, 'Plugin UI entry missing')
    font_source_files(commit, source(commit, 'src-tauri/resources/sumi/manifest.json'))
    modules = json.loads(subprocess.check_output(['node', str(Path(__file__).with_name('verify-embedded.mjs')), '--inspect', str(args.dist)]))
    return {'schema': 1, 'source': commit, 'version': VERSION, 'plugin_version': PLUGIN_VERSION,
            'source_sha256': {p: sha(source(commit, p)) for p in SOURCES}, 'host_modules': modules, 'plugin_files': files}


def verify(args, report):
    h = helper(args.candidate_helper)
    require(args.tag == 'v'+VERSION and re.fullmatch('[0-9a-f]{40}', args.expected_source or ''), 'Wrong release tag/source')
    require(git('rev-parse', args.tag+'^{commit}').decode().strip() == args.expected_source, 'Tag not at frozen source')
    frozen = json.loads(args.inputs.read_bytes())
    require(frozen.get('source') == args.expected_source and frozen.get('version') == VERSION and frozen.get('plugin_version') == PLUGIN_VERSION and frozen.get('schema') == 1, 'Wrong frozen inputs')
    require(set(frozen['source_sha256']) == set(SOURCES), 'Frozen source inventory mismatch')
    for path, digest in frozen['source_sha256'].items():
        require(sha(source(args.expected_source, path)) == digest, 'Frozen source mismatch: '+path)
    for path in ['package.json', 'src-tauri/tauri.conf.json']:
        require(json.loads(source(args.expected_source, path))['version'] == VERSION, 'Source version mismatch: '+path)
    config = json.loads(source(args.expected_source, 'src-tauri/tauri.conf.json'))
    require(config['identifier'] == 'net.notemd.app', 'Nonproduction Tauri identifier')
    require(re.search(rb'^version\s*=\s*"'+VERSION.encode()+rb'"', source(args.expected_source,'src-tauri/Cargo.toml'), re.M), 'Cargo version mismatch')
    app = args.app.resolve(strict=True)
    h.verify_app_identity(plistlib.loads((app/'Contents/Info.plist').read_bytes()), VERSION)
    binary = app/'Contents/MacOS/notemd'
    before = h.file_info(binary)
    verify_architecture(h.check_command(report, ['/usr/bin/lipo','-archs',str(binary)]), args.arch)
    h.check_command(report, ['/usr/bin/codesign','--verify','--deep','--strict','--verbose=2',str(app)])
    h.check_command(report, ['/usr/sbin/spctl','--assess','--type','execute','--verbose=4',str(app)])
    require('Notarized Developer ID' in report['commands'][-1]['stderr'], 'App not notarized Developer ID')
    h.check_command(report, ['/usr/bin/xcrun','stapler','validate',str(app)])
    libraries = h.check_command(report, ['/usr/bin/otool','-L',str(binary)])
    # ObjC class metadata survives symbol stripping; do not require debug symbols.
    objc = subprocess.check_output(['/usr/bin/otool','-ov',str(binary)], text=True, timeout=120)
    native_evidence(libraries, objc)
    report['native_bridge'] = {'classes':['SumiTextView','SumiEditor'], 'qt_dynamic_linkage':False}
    manifest_raw = source(args.expected_source,'src-tauri/resources/sumi/manifest.json')
    report['font_source_assets'] = font_source_files(args.expected_source, manifest_raw)
    no_bundled_fonts(app)
    report['fonts'] = font_files(app/'Contents/Resources/resources/sumi', manifest_raw)
    code_resources = (app/'Contents/_CodeSignature/CodeResources').read_bytes()
    def resource_check(candidate):
        no_bundled_fonts(candidate.parent)  # Entire readonly DMG, including files outside the app.
        require((candidate/'Contents/_CodeSignature/CodeResources').read_bytes() == code_resources, 'Distribution signed resource inventory differs from app')
        font_files(candidate/'Contents/Resources/resources/sumi', manifest_raw)

    report['embedded_js'] = json.loads(h.check_command(report, ['node',str(Path(__file__).with_name('verify-embedded.mjs')),'--arch',args.arch,str(binary),str(args.depfile),str(args.dist),str(args.inputs),str(ROOT/'src-tauri/target')]))
    report['updater'] = h.file_info(args.updater)
    report['updater']['identity'] = h.verify_archive_identity(args.updater, VERSION)
    updater_signature = args.updater_signature or Path(str(args.updater)+'.sig')
    # Tauri's .sig and configured public key wrap the usual minisign text in
    # base64, matching scripts/release.sh's exact post-notarize verification.
    public_lines = base64.b64decode(config['plugins']['updater']['pubkey'], validate=True).decode().splitlines()
    require(len(public_lines) == 2, 'Invalid frozen updater public key')
    signature_text = base64.b64decode(updater_signature.read_bytes().strip(), validate=True)
    with tempfile.TemporaryDirectory(prefix='sumi-updater-signature-') as temporary:
        signature_path = Path(temporary)/'updater.minisig'
        signature_path.write_bytes(signature_text)
        h.check_command(report, ['minisign','-V','-P',public_lines[1],'-m',str(args.updater),'-x',str(signature_path)])
    report['updater']['signature'] = h.file_info(updater_signature)
    with tempfile.TemporaryDirectory(prefix='sumi-release-verify-') as temporary:
        extracted = Path(temporary)/'notemd'
        h.unpack_binary(args.updater,'note.md.app/Contents/MacOS/notemd',extracted)
        require(h.file_info(extracted)['sha256'] == before['sha256'], 'Updater binary mismatch')
    # Read only named bounded resources; never extract the archive tree.
    expected_resources = {'Contents/_CodeSignature/CodeResources':code_resources,
                          'Contents/Resources/resources/sumi/manifest.json':manifest_raw}
    for asset in font_manifest(manifest_raw)['assets']:
        if asset['file'] not in BUNDLED_FONT_METADATA:
            continue
        expected_resources['Contents/Resources/resources/sumi/'+asset['file']] = (app/'Contents/Resources/resources/sumi'/asset['file']).read_bytes()
    with tarfile.open(args.updater,'r:gz') as archive:
        updater_resources(archive, expected_resources)
    report['dmg'] = h.file_info(args.dmg)
    h.check_command(report, ['/usr/bin/xcrun','stapler','validate',str(args.dmg)])
    h.check_command(report, ['/usr/sbin/spctl','--assess','--type','open','--context','context:primary-signature','--verbose=4',str(args.dmg)])
    h.verify_dmg_binary(report,args.dmg,before['sha256'],VERSION,resource_check)
    require(re.fullmatch('[0-9a-f]{64}', args.expected_plugin_sha256 or ''), 'Expected plugin package SHA-256 required')
    report['plugin'] = h.file_info(args.plugin_package)
    require(report['plugin']['sha256'] == args.expected_plugin_sha256, 'Plugin package SHA mismatch')
    verify_plugin_files(zip_files(args.plugin_package), frozen['plugin_files'])
    key_source = source(args.expected_source,'src-tauri/src/plugin_runtime/market.rs')
    key = re.search(rb'pub const PLUGIN_REGISTRY_PUBKEY:\s*&str\s*=\s*"([^"]+)"',key_source)
    require(key is not None, 'Frozen registry public key missing')
    h.check_command(report, ['minisign','-Vm',str(args.plugin_package),'-x',str(args.signature),'-P',key[1].decode()])
    report['plugin']['signature'] = h.file_info(args.signature)
    require(h.file_info(binary) == before, 'App changed during verification')
    require(h.file_info(args.updater)['sha256'] == report['updater']['sha256'], 'Updater changed during verification')
    require(h.file_info(args.dmg)['sha256'] == report['dmg']['sha256'], 'DMG changed during verification')
    require(h.file_info(args.plugin_package)['sha256'] == report['plugin']['sha256'], 'Plugin changed during verification')
    report.update(source=args.expected_source, tag=args.tag, architecture=args.arch, app_binary=before, inputs=h.file_info(args.inputs), reused_helper=h.file_info(args.candidate_helper), limits='Read-only artifact/source/whole-module proof. No app launch, installation, runtime routing, physical input, IME or UI acceptance claimed.')


def self_test():
    import io
    h = helper(Path(__file__).with_name('artifact_checks.py'))
    def rejects(action):
        try:
            action()
        except (RuntimeError, KeyError, ValueError):
            return
        raise RuntimeError('Negative fixture unexpectedly accepted')
    production={'CFBundleIdentifier':'net.notemd.app','CFBundleShortVersionString':VERSION,'CFBundleExecutable':'notemd'}
    for arch in ('arm64', 'x86_64'):
        verify_architecture(arch, arch)
        rejects(lambda: verify_architecture('x86_64' if arch == 'arm64' else 'arm64', arch))
        rejects(lambda: verify_architecture('arm64 x86_64', arch))
    rejects(lambda: verify_architecture('i386', 'i386'))
    h.verify_app_identity(production, VERSION)
    rejects(lambda:h.verify_app_identity({**production,'CFBundleIdentifier':'net.notemd.sumi.acceptance'},VERSION))
    rejects(lambda:h.verify_app_identity({**production,'CFBundleShortVersionString':'6.1107.5'},VERSION))
    manifest = {'id':'notemd.sumi','version':PLUGIN_VERSION,'manifest_version':2,'ui':'ui/',
                'capabilities':['editor.native'],'contributes':{'file_views':[{'surface':'native-editor'}]}}
    raw = json.dumps(manifest).encode()
    files = {'manifest.json':raw,'ui/index.html':b'fixture'}
    frozen = {n:sha(b) for n,b in files.items()}
    verify_plugin_files(files,frozen)
    rejects(lambda: verify_plugin_files({**files,'ui/index.html':b'tampered'},frozen))
    rejects(lambda: verify_plugin_files({'manifest.json':raw},frozen))
    with_font={**files,'ui/fonts/embedded.ttf':b'font'}
    rejects(lambda: verify_plugin_files(with_font,{n:sha(b) for n,b in with_font.items()}))
    rejects(lambda: manifest_identity({**manifest,'version':'0.0.0'}))
    rejects(lambda: manifest_identity({**manifest,'capabilities':[]}))
    native_evidence('AppKit.framework CoreText.framework','SumiTextView SumiEditor')
    rejects(lambda: native_evidence('AppKit.framework CoreText.framework Qt6Widgets','SumiTextView SumiEditor'))
    rejects(lambda: native_evidence('AppKit.framework CoreText.framework','NSTextView'))
    with tempfile.TemporaryDirectory(prefix='sumi-verifier-test-') as temporary:
        directory = Path(temporary)
        package = directory/'fixture.zip'
        with zipfile.ZipFile(package,'w') as archive:
            for name,data in files.items():
                archive.writestr(name,data)
        verify_plugin_files(zip_files(package),frozen)
        for name,mode in [('../escape',stat.S_IFREG),('/absolute',stat.S_IFREG),('link',stat.S_IFLNK)]:
            with zipfile.ZipFile(package,'w') as archive:
                entry=zipfile.ZipInfo(name);entry.external_attr=mode<<16;archive.writestr(entry,b'fixture')
            rejects(lambda: zip_files(package))
        fixture=ROOT/'src-tauri/tests/fixtures/pkg'
        key=(fixture/'test.pub.b64').read_text().strip()
        check=['minisign','-Vm',str(fixture/'fixture.notemdpkg'),'-x',str(fixture/'fixture.notemdpkg.minisig'),'-P',key]
        # Verify the same wrapped signature form emitted for Tauri updaters.
        wrapped=base64.b64encode((fixture/'fixture.notemdpkg.minisig').read_bytes())
        decoded=directory/'updater.minisig';decoded.write_bytes(base64.b64decode(wrapped,validate=True))
        check[4]=str(decoded)
        good=subprocess.run(check,capture_output=True)
        require(good.returncode==0,'Existing signed installer fixture failed minisign verification')
        altered=directory/'altered.notemdpkg';altered.write_bytes((fixture/'fixture.notemdpkg').read_bytes()+b'changed')
        check[2]=str(altered)
        require(subprocess.run(check,capture_output=True).returncode!=0,'Tampered signed package accepted')
        archive_path=directory/'updater.tar.gz'
        for mode in ['valid','isolated','duplicate','symlink']:
            value={**production,'CFBundleIdentifier':'net.notemd.sumi.acceptance' if mode=='isolated' else 'net.notemd.app'}
            data=plistlib.dumps(value)
            with tarfile.open(archive_path,'w:gz') as archive:
                for _ in range(2 if mode=='duplicate' else 1):
                    member=tarfile.TarInfo('note.md.app/Contents/Info.plist');member.size=len(data)
                    if mode=='symlink':member.type=tarfile.SYMTYPE;member.linkname='/etc/passwd';archive.addfile(member)
                    else:archive.addfile(member,io.BytesIO(data))
            if mode=='valid':h.verify_archive_identity(archive_path,VERSION)
            else:rejects(lambda:h.verify_archive_identity(archive_path,VERSION))
        directory=directory/'fonts';directory.mkdir()
        fm=json.loads((ROOT/'src-tauri/resources/sumi/manifest.json').read_bytes())
        for asset in fm['assets']:
            asset.update(size=7,sha256=sha(b'fixture'))
        encoded=json.dumps(fm).encode();(directory/'manifest.json').write_bytes(encoded)
        from unittest.mock import patch
        source_root=directory.parent/'source';font_root=source_root/'src-tauri/resources/sumi';font_root.mkdir(parents=True)
        with patch.dict(globals(), {'ROOT':source_root, 'source':lambda commit,path:b'fixture'}):
            check=font_source_files('fixture',encoded)
            require(set(check['unavailable_local_fonts'])==set(FONT_FACES), 'Thin source must allow absent ignored fonts')
            local=font_root/next(iter(FONT_FACES));local.write_bytes(b'fixture')
            require(len(font_source_files('fixture',encoded)['local_development_fonts'])==1, 'Local development font not checked')
            local.write_bytes(b'changed');rejects(lambda:font_source_files('fixture',encoded));local.unlink()
        with patch.dict(globals(), {'ROOT':source_root, 'source':lambda commit,path:b'tamper'}):
            rejects(lambda:font_source_files('fixture',encoded))
        for n in BUNDLED_FONT_METADATA:(directory/n).write_bytes(b'fixture')
        font_files(directory,encoded)
        no_bundled_fonts(directory)
        for retired in ['SourceHanSerifSC-Regular.otf','SpecialElite-Regular.ttf','YouyouYisong-PROVENANCE.json','TerminusTTF-4.46.0.ttf','TerminusTTF-OFL.txt','nested']:
            obsolete=directory/retired
            if retired == 'nested':obsolete.mkdir()
            else:obsolete.write_bytes(b'old resource')
            rejects(lambda: font_files(directory,encoded))
            if obsolete.is_dir():obsolete.rmdir()
            else:obsolete.unlink()
        for name in FONT_FACES:
            unexpected=directory/name;unexpected.write_bytes(b'fixture')
            rejects(lambda: font_files(directory,encoded));rejects(lambda: no_bundled_fonts(directory));unexpected.unlink()
        outer=directory.parent/'other';outer.mkdir()
        for name in ['font.WOFF','font.woff2','font.ttc','font.otc']:
            unexpected=outer/name;unexpected.write_bytes(b'fixture')
            rejects(lambda: no_bundled_fonts(directory.parent));unexpected.unlink()
        name=sorted(BUNDLED_FONT_METADATA)[0];path=directory/name
        path.unlink();rejects(lambda: font_files(directory,encoded))
        path.mkdir();rejects(lambda: font_files(directory,encoded));path.rmdir()
        target=outer/'metadata';target.write_bytes(b'fixture');path.symlink_to(target)
        rejects(lambda: font_files(directory,encoded));path.unlink()
        path.write_bytes(b'changed');rejects(lambda: font_files(directory,encoded));path.write_bytes(b'fixture')
        rejects(lambda: font_files(directory,encoded+b' '))
        def altered_manifest(change):
            bad=json.loads(encoded);change(bad);return json.dumps(bad).encode()
        for change in [
            lambda m:m['cascades']['Sumi Plex'].append('WrongFace'),
            lambda m:m['cascades']['Sumi CRT'].insert(0,'TerminusTTF'),
            lambda m:m['assets'].pop(),
            lambda m:m['assets'].append(m['assets'][0]),
            lambda m:m['assets'][0].update(postscript='WrongFace'),
            lambda m:m['assets'][0].update(size=0),
            lambda m:m['assets'][0].update(sha256='0'*64),
            lambda m:m['assets'][0].update(url='http://example.com/font.ttf'),
            lambda m:next(a for a in m['assets'] if a['file']=='ZhuqueFangsong-Regular.ttf').pop('archive_sha256'),
            lambda m:next(a for a in m['assets'] if a['file']=='ZhuqueFangsong-Regular.ttf').update(archive_size=0),
        ]:
            rejects(lambda change=change: font_manifest(altered_manifest(change)))
        resource_prefix='Contents/Resources/resources/sumi/'
        expected={resource_prefix+p.name:p.read_bytes() for p in directory.iterdir()}
        expected['Contents/_CodeSignature/CodeResources']=b'signed resources'
        def resource_archive(mode):
            data=dict(expected)
            if mode=='tampered':data[resource_prefix+name]=b'changed'
            if mode=='missing':del data[resource_prefix+name]
            if mode=='obsolete':data[resource_prefix+'old.json']=b'old'
            if mode=='nested':data[resource_prefix+'nested/metadata.json']=b'old'
            if mode=='font':data['Contents/Other/font.WOFF2']=b'font'
            with tarfile.open(archive_path,'w:gz') as archive:
                for n,raw in data.items():
                    member=tarfile.TarInfo('note.md.app/'+n);member.size=len(raw)
                    if n==resource_prefix+name and mode in ('directory','symlink'):
                        member.type=tarfile.DIRTYPE if mode=='directory' else tarfile.SYMTYPE
                        member.linkname='elsewhere';archive.addfile(member)
                    else:archive.addfile(member,io.BytesIO(raw))
                    if n==resource_prefix+name and mode=='duplicate':archive.addfile(member,io.BytesIO(raw))
            with tarfile.open(archive_path,'r:gz') as archive:updater_resources(archive,expected)
        resource_archive('valid')
        for mode in ['tampered','missing','obsolete','nested','font','directory','symlink','duplicate']:
            rejects(lambda mode=mode:resource_archive(mode))
    subprocess.run(['node',str(Path(__file__).with_name('verify-embedded.mjs')),'--self-test'],check=True)
    return {'ok':True,'offline':True,'checks':['arm64-and-x86_64-positive-wrong-or-universal-CPU-rejected','plugin-identity','exact-ui-inventory-and-bytes','stale-version-and-capability-rejected','zip-traversal-and-symlink-rejected','thin-metadata-only-app-and-updater-positive','complete-font-catalog-exact-faces-sizes-digests-URLs-and-Zhuque-archive','font-payload-anywhere-in-distribution-or-plugin-rejected','obsolete-missing-tampered-directory-symlink-duplicate-metadata-rejected','native-classes-and-no-Qt','whole-JS-module-positive-negative','real-minisign-fixture-and-tamper','production-version-and-identity','updater-plist-duplicate-symlink-isolated-rejected']}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--freeze-inputs',action='store_true')
    p.add_argument('--self-test',action='store_true')
    p.add_argument('--tag',default='v'+VERSION)
    p.add_argument('--arch',choices=('arm64','x86_64'),default='arm64',help='Expected thin Mach-O CPU; default arm64')
    p.add_argument('--expected-source')
    p.add_argument('--inputs',type=Path)
    p.add_argument('--app',type=Path)
    p.add_argument('--depfile',type=Path)
    p.add_argument('--dmg',type=Path)
    p.add_argument('--updater',type=Path)
    p.add_argument('--updater-signature',type=Path,help='Defaults to <updater>.sig; Tauri base64 signature')
    p.add_argument('--plugin-package',type=Path)
    p.add_argument('--signature',type=Path)
    p.add_argument('--expected-plugin-sha256')
    p.add_argument('--dist',type=Path,default=ROOT/'dist')
    p.add_argument('--plugin-ui',type=Path,default=ROOT/'plugins-src/write/dist')
    p.add_argument('--candidate-helper',type=Path,default=Path(__file__).with_name('artifact_checks.py'))
    p.add_argument('--output',type=Path)
    args=p.parse_args();report={'ok':False,'checked_at':datetime.now(timezone.utc).isoformat()}
    try:
        if args.self_test: report=self_test()
        elif args.freeze_inputs:
            require(args.expected_source and args.output,'Freeze requires source and output')
            report=freeze(args)
        else:
            require(all([args.inputs,args.expected_source,args.app,args.depfile,args.dmg,args.updater,args.plugin_package,args.signature,args.output]),'Missing release input (see --help)')
            verify(args,report);report['ok']=True
        if args.output:args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({'ok':True,'mode':'self-test' if args.self_test else 'freeze' if args.freeze_inputs else 'verify','output':str(args.output) if args.output else None}))
        return 0
    except Exception as error:
        report.update(ok=False,error=str(error))
        if args.output:args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps({'ok':False,'error':str(error)}));return 1


if __name__ == '__main__':
    raise SystemExit(main())
