"""Prepare Sumi 0.1.16 from verified public 0.1.15 packages, without backend rebuilds.

Run only after the corrected UI was built to ui-build/. No publication occurs.
The candidate deliberately has no sourceCommit until publish-plugin.py freeze.
"""
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ARCHS = ['aarch64-apple-darwin', 'x86_64-unknown-linux-gnu']
ID, VERSION, BASELINE = 'notemd.sumi', '0.1.16', '0.1.15'
MIN_HOST = '>=6.1111.1'
SOURCE_ROOTS = ['plugins-src/write', 'plugins-src/shared', 'src/lib/sumi',
                'sumi-protocol', 'write-core', 'notemd-plugin-sdk', 'plugin-protocol']


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(name, value):
    (HERE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def public_key():
    return re.search(r'PLUGIN_REGISTRY_PUBKEY: &str =\s*"([^"]+)"',
                     (ROOT / 'src-tauri/src/plugin_runtime/market.rs').read_text())[1]


def verify_signature(path):
    result = subprocess.run(['minisign', '-Vm', str(path), '-P', public_key()], capture_output=True)
    require(result.returncode == 0, 'Package Minisign verification failed: ' + str(path))


def inventory(path):
    with zipfile.ZipFile(path) as archive:
        names = [i.filename for i in archive.infolist() if not i.is_dir()]
        require(len(names) == len(set(names)), 'Duplicate ZIP entries')
        require(all(not n.startswith('/') and '..' not in Path(n).parts for n in names), 'Unsafe ZIP path')
        return {n: archive.read(n) for n in names}


def source_inputs():
    names = subprocess.check_output(['git', 'ls-files', '-z', '--', *SOURCE_ROOTS,
                                    'pnpm-lock.yaml', 'package.json'], cwd=ROOT).decode().split('\0')
    return {name: sha((ROOT / name).read_bytes()) for name in names if name}


def check_candidate(source=None):
    name = 'frozen-plugin-packages.json' if source else 'candidate-plugin-packages.json'
    frozen = json.loads((HERE / name).read_text())
    require(frozen['sourceRepository'] == str(ROOT), 'Unexpected source repository')
    require(frozen['sourceCommit'] == source, 'Candidate must not claim an unfrozen source')
    if source:
        require(re.fullmatch('[0-9a-f]{40}', source), 'Full source commit required')
        for path, digest in frozen['sourceFiles'].items():
            raw = subprocess.check_output(['git', 'show', source + ':' + path], cwd=ROOT)
            require(sha(raw) == digest, 'Frozen source differs from built input: ' + path)
    require([(r['id'], r['version'], r['arch']) for r in frozen['packages']] ==
            [(ID, VERSION, arch) for arch in ARCHS], 'Only Sumi 0.1.16 dual architecture packages allowed')
    manifests = []
    for row in frozen['packages']:
        package = HERE / row['packagePath']
        require(sha(package.read_bytes()) == row['sha256'] and package.stat().st_size == row['bytes'], 'Package changed')
        require(sha(Path(str(package) + '.minisig').read_bytes()) == row['signatureSha256'], 'Signature changed')
        verify_signature(package)
        files = inventory(package)
        require({n: sha(b) for n, b in files.items()} == row['files'], 'Package inventory changed')
        manifest = json.loads(files['manifest.json'])
        require((manifest['id'], manifest['version'], manifest['engines']['notemd']) ==
                (ID, VERSION, MIN_HOST), 'Plugin identity/minimum host changed')
        require(sha(files['manifest.json']) == frozen['sourceFiles']['plugins-src/write/manifest.v2.json'],
                'Manifest differs from source receipt')
        js = [b for n, b in files.items() if n.startswith('ui/assets/') and n.endswith('.js')]
        require(len(js) == 1 and js[0].count(b'Fcitx5 for Sumi') == 3 and b'Faitc5' not in js[0], 'Corrected UI missing')
        require(not any(n.startswith('ui/sounds/') for n in files), 'Duplicate sound assets')
        require(all(Path(n).suffix.lower() not in {'.ttf', '.otf', '.ttc', '.woff', '.woff2'} for n in files), 'Font payload forbidden')
        previous = HERE / 'previous' / (row['arch'] + '.notemdpkg')
        verify_signature(previous)
        old = inventory(previous)
        require(sha(previous.read_bytes()) == row['previousSha256'], 'Verified baseline changed')
        retained = {n: b for n, b in old.items() if n != 'manifest.json' and not n.startswith('ui/')}
        require(retained == {n: b for n, b in files.items() if n != 'manifest.json' and not n.startswith('ui/')},
                'Native backend/resources changed')
        oldjs = [b for n, b in old.items() if n.startswith('ui/assets/') and n.endswith('.js')]
        require(len(oldjs) == 1 and oldjs[0].replace(b'Faitc5', b'Fcitx5') == js[0], 'UI change exceeds spelling correction')
        manifests.append(manifest)
    require(manifests[0] == manifests[1], 'Architecture manifests differ')
    return frozen


def prepare():
    baseline = json.loads((HERE / 'baseline-index.json').read_text())
    row = next(r for r in baseline['plugins'] if (r['id'], r['version']) == (ID, BASELINE))
    require(row['archs'] == ARCHS, 'Public baseline architectures changed')
    require(not any((r['id'], r['version']) == (ID, VERSION) for r in baseline['plugins']), 'Version already occupied in baseline')
    manifest_bytes = (ROOT / 'plugins-src/write/manifest.v2.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    require((manifest['version'], manifest['engines']['notemd']) == (VERSION, MIN_HOST), 'Version/minimum host differs')
    require(json.loads((ROOT / 'plugins-src/write/package.json').read_text())['version'] == VERSION, 'Package version differs')
    built = {'ui/' + str(p.relative_to(HERE / 'ui-build')): p.read_bytes()
             for p in (HERE / 'ui-build').rglob('*') if p.is_file() and 'sounds' not in p.relative_to(HERE / 'ui-build').parts}
    rows, proofs = [], []
    inputs = source_inputs()
    for arch in ARCHS:
        previous = HERE / 'previous' / (arch + '.notemdpkg')
        require(sha(previous.read_bytes()) == row['sha256'][arch], 'Baseline does not match public index')
        verify_signature(previous)
        old = inventory(previous)
        old_manifest = json.loads(old['manifest.json'])
        old_manifest['version'] = VERSION
        require(old_manifest == manifest, 'Only manifest version may change')
        old_ui = {n: b for n, b in old.items() if n.startswith('ui/')}
        old_js = next(n for n in old_ui if n.endswith('.js'))
        new_js = next(n for n in built if n.endswith('.js'))
        require(old_ui[old_js].replace(b'Faitc5', b'Fcitx5') == built[new_js], 'Built UI has unrelated changes')
        for n, raw in old_ui.items():
            if n == old_js:
                continue
            expected = raw.replace(Path(old_js).name.encode(), Path(new_js).name.encode()) if n == 'ui/index.html' else raw
            require(built.get(n) == expected, 'Other UI resource changed: ' + n)
        require(set(built) == (set(old_ui) - {old_js}) | {new_js}, 'UI inventory changed beyond renamed JS')
        destination = HERE / 'packages' / ID / VERSION / (arch + '.notemdpkg')
        destination.parent.mkdir(parents=True, exist_ok=True)
        require(not destination.exists(), 'Prepared immutable package already exists; use check')
        with zipfile.ZipFile(previous) as zin, zipfile.ZipFile(destination, 'w') as zout:
            for info in zin.infolist():
                raw = zin.read(info)
                if info.filename == 'manifest.json':
                    raw = manifest_bytes
                elif info.filename == old_js:
                    info.filename, raw = new_js, built[new_js]
                elif info.filename in built:
                    raw = built[info.filename]
                zout.writestr(info, raw)
        # Invoke the established signing tool; never read or print key contents.
        result = subprocess.run(['minisign', '-S', '-s', str(Path.home() / '.tauri/notemd-plugins.key'),
                                 '-m', str(destination)], input='\n', text=True, capture_output=True)
        require(result.returncode == 0, 'Plugin signing failed')
        verify_signature(destination)
        files = inventory(destination)
        rows.append({'id': ID, 'version': VERSION, 'arch': arch, 'packagePath': str(destination.relative_to(HERE)),
                     'sha256': sha(destination.read_bytes()), 'bytes': destination.stat().st_size,
                     'signatureSha256': sha(Path(str(destination) + '.minisig').read_bytes()),
                     'previousSha256': sha(previous.read_bytes()), 'files': {n: sha(b) for n, b in files.items()}})
        proofs.append({'arch': arch, 'previousVersion': BASELINE, 'previousPackageSha256': sha(previous.read_bytes()),
                       'previousMinisignVerified': True, 'backendSha256': sha(files['bin/notemd-sumi']),
                       'retainedFiles': {n: sha(b) for n, b in files.items() if n != 'manifest.json' and not n.startswith('ui/')},
                       'uiExactChange': 'Three Faitc5 -> Fcitx5 byte replacements; index.html references new content hash',
                       'uiOtherFilesIdentical': True, 'newBackendBuildOrSigningOrNotarization': False})
    require(source_inputs() == inputs, 'Source changed during package preparation')
    save('candidate-plugin-packages.json', {'schema': 1, 'sourceRepository': str(ROOT), 'sourceCommit': None,
         'sourceStatus': 'pending final committed source; not eligible for publication', 'sourceFiles': inputs,
         'packages': rows})
    save('package-reuse-proof.json', {'ok': True, 'packages': proofs})
    check_candidate()
    print('Prepared signed Sumi 0.1.16 dual architecture candidates; sourceCommit pending; no publication')


if __name__ == '__main__':
    prepare()
