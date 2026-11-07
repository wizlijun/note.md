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
VERSION = '6.1108.1'
PLUGIN_VERSION = '0.1.0'
SOURCES = ['src/components/NativeFileView.svelte', 'src/components/SumiRecovery.svelte',
           'src/lib/sumi/session.ts', 'src/lib/sumi/recovery.ts', 'src/App.svelte',
           'src-tauri/src/sumi/mod.rs', 'src-tauri/src/sumi/export.rs',
           'src-tauri/src/sumi/recovery.rs', 'src-tauri/src/sumi/external.rs',
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
        require(sha(raw) == frozen[name], 'Plugin package bytes changed: '+name)
    manifest_identity(json.loads(files['manifest.json']))


def font_files(folder, manifest_raw):
    require((folder/'manifest.json').read_bytes() == manifest_raw, 'Bundled font manifest differs from frozen source')
    manifest = json.loads(manifest_raw)
    require(manifest.get('alias') == 'Sumi Typewriter', 'Wrong font alias')
    require(manifest.get('families') == ['Special Elite','Zhuque Fangsong (technical preview)','Source Han Serif SC'], 'Wrong font cascade')
    expected = {'SpecialElite-Regular.ttf', 'SpecialElite-LICENSE.txt', 'ZhuqueFangsong-Regular.ttf',
                'ZhuqueFangsong-LICENSE.txt', 'SourceHanSerifSC-Regular.otf', 'OFL.txt'}
    require({a['file'] for a in manifest['assets']} == expected and len(manifest['assets']) == 6, 'Incomplete font/license manifest')
    result = {}
    for asset in manifest['assets']:
        raw = (folder/asset['file']).read_bytes()
        require(len(raw) == asset['size'] and sha(raw) == asset['sha256'], 'Font/license mismatch: '+asset['file'])
        result[asset['file']] = sha(raw)
    return result


def native_evidence(libraries, objc):
    require(not re.search(r'(?i)(?:Qt(?:Core|Gui|Widgets|[456])|/Qt[^/]*\.framework)', libraries), 'Unexpected Qt linkage')
    for framework in ['AppKit.framework', 'CoreText.framework']:
        require(framework in libraries, 'Missing native framework '+framework)
    for name in ['SumiTextView', 'SumiEditor']:
        require(name in objc, 'Missing linked Objective-C native bridge class '+name)


def freeze(args):
    commit = git('rev-parse', args.expected_source+'^{commit}').decode().strip()
    require(commit == args.expected_source, 'Use exact frozen 40-character commit')
    raw = source(commit, 'plugins-src/write/manifest.v2.json')
    manifest_identity(json.loads(raw))
    files = {'manifest.json': sha(raw)}
    for path in sorted(args.plugin_ui.rglob('*')):
        if path.is_file():
            require(not path.is_symlink(), 'Plugin UI symlink')
            files['ui/'+path.relative_to(args.plugin_ui).as_posix()] = sha(path.read_bytes())
    require('ui/index.html' in files, 'Plugin UI entry missing')
    modules = json.loads(subprocess.check_output(['node', str(Path(__file__).with_name('verify-embedded.mjs')), '--inspect', str(args.dist)]))
    return {'schema': 1, 'source': commit, 'version': VERSION, 'plugin_version': PLUGIN_VERSION,
            'source_sha256': {p: sha(source(commit, p)) for p in SOURCES}, 'host_modules': modules, 'plugin_files': files}


def verify(args, report):
    h = helper(args.candidate_helper)
    require(args.tag == 'v'+VERSION and re.fullmatch('[0-9a-f]{40}', args.expected_source or ''), 'Wrong release tag/source')
    require(git('rev-parse', args.tag+'^{commit}').decode().strip() == args.expected_source, 'Tag not at frozen source')
    frozen = json.loads(args.inputs.read_bytes())
    require(frozen.get('source') == args.expected_source and frozen.get('version') == VERSION and frozen.get('schema') == 1, 'Wrong frozen inputs')
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
    require(h.check_command(report, ['/usr/bin/lipo','-archs',str(binary)]) == 'arm64', 'Expected arm64 release')
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
    report['fonts'] = font_files(app/'Contents/Resources/resources/sumi', manifest_raw)
    code_resources = (app/'Contents/_CodeSignature/CodeResources').read_bytes()
    def resource_check(candidate):
        require((candidate/'Contents/_CodeSignature/CodeResources').read_bytes() == code_resources, 'Distribution signed resource inventory differs from app')
        font_files(candidate/'Contents/Resources/resources/sumi', manifest_raw)

    report['embedded_js'] = json.loads(h.check_command(report, ['node',str(Path(__file__).with_name('verify-embedded.mjs')),str(binary),str(args.depfile),str(args.dist),str(args.inputs),str(ROOT/'src-tauri/target')]))
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
    for asset in json.loads(manifest_raw)['assets']:
        expected_resources['Contents/Resources/resources/sumi/'+asset['file']] = (app/'Contents/Resources/resources/sumi'/asset['file']).read_bytes()
    with tarfile.open(args.updater,'r:gz') as archive:
        for relative,expected in expected_resources.items():
            entries=[m for m in archive.getmembers() if m.name.removeprefix('./') == 'note.md.app/'+relative]
            require(len(entries)==1 and entries[0].isfile() and entries[0].size==len(expected), 'Updater resource inventory mismatch: '+relative)
            with archive.extractfile(entries[0]) as stream:
                require(stream.read()==expected, 'Updater resource mismatch: '+relative)
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
    report.update(source=args.expected_source, tag=args.tag, app_binary=before, inputs=h.file_info(args.inputs), reused_helper=h.file_info(args.candidate_helper), limits='Read-only artifact/source/whole-module proof. No app launch, installation, runtime routing, physical input, IME or UI acceptance claimed.')


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
        names=['SpecialElite-Regular.ttf','SpecialElite-LICENSE.txt','ZhuqueFangsong-Regular.ttf','ZhuqueFangsong-LICENSE.txt','SourceHanSerifSC-Regular.otf','OFL.txt']
        fm={'alias':'Sumi Typewriter','families':['Special Elite','Zhuque Fangsong (technical preview)','Source Han Serif SC'],'assets':[{'file':n,'size':7,'sha256':sha(b'fixture')} for n in names]}
        encoded=json.dumps(fm).encode();(directory/'manifest.json').write_bytes(encoded)
        for n in names:(directory/n).write_bytes(b'fixture')
        font_files(directory,encoded)
        (directory/names[-1]).write_bytes(b'changed')
        rejects(lambda: font_files(directory,encoded))
        rejects(lambda: font_files(directory,encoded+b' '))
    subprocess.run(['node',str(Path(__file__).with_name('verify-embedded.mjs')),'--self-test'],check=True)
    return {'ok':True,'offline':True,'checks':['plugin-identity','exact-ui-inventory-and-bytes','stale-version-and-capability-rejected','zip-traversal-and-symlink-rejected','six-font-license-hashes','tampered-font-and-manifest-rejected','native-classes-and-no-Qt','whole-JS-module-positive-negative','real-minisign-fixture-and-tamper','production-version-and-identity','updater-plist-duplicate-symlink-isolated-rejected']}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--freeze-inputs',action='store_true')
    p.add_argument('--self-test',action='store_true')
    p.add_argument('--tag',default='v'+VERSION)
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
