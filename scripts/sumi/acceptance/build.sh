#!/bin/bash
# Build and inspect the isolated host. Never launch it from this script.
set -euo pipefail
sumi_repo="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$sumi_repo"
python3 - <<'PY'
import json,tomllib
from pathlib import Path
root=Path.cwd()
package=json.loads((root/'package.json').read_text())['version']
cargo=tomllib.loads((root/'src-tauri/Cargo.toml').read_text())['package']['version']
config=json.loads((root/'src-tauri/tauri.conf.json').read_text())['version']
required=json.loads((root/'plugins-src/write/manifest.v2.json').read_text())['engines']['notemd'].removeprefix('>=')
if len({package,cargo,config})!=1 or tuple(map(int,package.split('.')))<tuple(map(int,required.split('.'))):
    raise SystemExit('First align the host release version with the Sumi manifest; never lower the manifest requirement for acceptance.')
feature=tomllib.loads((root/'src-tauri/Cargo.toml').read_text()).get('features',{})
if 'sumi-acceptance' not in feature:raise SystemExit('Missing isolation feature')
print('Acceptance host version:',package)
PY
env pnpm_config_verify_deps_before_run=false pnpm build
(
  cd plugins-src/write
  ../../node_modules/.bin/vite build
)
env RUSTUP_TOOLCHAIN=1.99.0 cargo build --locked --manifest-path plugins-src/write/backend/Cargo.toml --target aarch64-apple-darwin --bin notemd-sumi
sumi_backend="$sumi_repo/plugins-src/write/backend/target/aarch64-apple-darwin/debug/notemd-sumi"
sumi_sign_args=(--force --options runtime --identifier net.notemd.sumi.acceptance.backend --sign "${SUMI_ACCEPTANCE_SIGNING_IDENTITY:--}")
if [[ "${SUMI_ACCEPTANCE_SIGNING_IDENTITY:--}" != "-" ]]; then sumi_sign_args+=(--timestamp); fi
codesign "${sumi_sign_args[@]}" "$sumi_backend"
codesign --verify --strict "$sumi_backend"
sumi_backend_sha=$(shasum -a 256 "$sumi_backend" | awk '{print $1}')
python3 scripts/sumi/acceptance/prepare.py --install --backend-binary "$sumi_backend" --backend-sha256 "$sumi_backend_sha"
python3 - <<'PY'
import json,sys
from pathlib import Path
root=Path.cwd()
sys.path.insert(0,str(root/'scripts/sumi/acceptance'))
from signing import configure, requested_identity
configure(root/'tasks/sumi-native/host-acceptance/tauri.acceptance.json',requested_identity())
support=Path.home()/'Library/Application Support/net.notemd.sumi.acceptance'
expected=json.loads((root/'tasks/sumi-native/host-acceptance/seed/.sumi-acceptance.json').read_text())
if not support.is_dir() or json.loads((support/'.sumi-acceptance.json').read_text())!=expected:
    raise SystemExit('Install the reviewed unique seed using prepare.py --install before building; no launch will be attempted.')
settings=json.loads((support/'settings.json').read_text())
if settings.get('mcpServer',{}).get('enabled') is not False:raise SystemExit('Acceptance MCP must remain disabled')
PY
env RUSTUP_TOOLCHAIN=1.99.0 \
  APPLE_SIGNING_IDENTITY="${SUMI_ACCEPTANCE_SIGNING_IDENTITY:--}" \
  SDKROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk \
  CARGO_TARGET_DIR="$sumi_repo/src-tauri/target" \
  CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_CODEGEN_UNITS=1 CARGO_INCREMENTAL=0 \
  ./node_modules/.bin/tauri build --debug --target aarch64-apple-darwin --features sumi-acceptance --bundles app --config "$sumi_repo/tasks/sumi-native/host-acceptance/tauri.acceptance.json"
python3 - <<'PY'
import hashlib,json,plistlib,sys
from pathlib import Path
root=Path.cwd()
sys.path.insert(0,str(root/'scripts/sumi/acceptance'))
from signing import inspect, requested_identity
app=root/'src-tauri/target/aarch64-apple-darwin/debug/bundle/macos/note.md Sumi Acceptance.app'
info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
if info['CFBundleIdentifier']!='net.notemd.sumi.acceptance':raise SystemExit('Wrong bundle identifier; do not launch')
if info.get('CFBundleDocumentTypes'):raise SystemExit('Acceptance bundle must not register document associations')
schemes=[scheme for row in info.get('CFBundleURLTypes',[]) for scheme in row.get('CFBundleURLSchemes',[])]
if schemes!=['notemd-sumi-acceptance']:raise SystemExit('Unexpected acceptance URL schemes')
manifest_raw=(root/'plugins-src/write/resources/sumi/manifest.json').read_bytes()
manifest=json.loads(manifest_raw)
if (app/'Contents/Resources/resources/sumi').exists():raise SystemExit('Acceptance host must not contain Sumi resources')
plugin=Path.home()/'Library/Application Support/net.notemd.sumi.acceptance/plugins/notemd.sumi/current'
metadata=plugin/'ui/sumi'
expected={'manifest.json'}|{a['file'] for a in manifest['assets'] if not a.get('postscript')}
if {p.name for p in metadata.iterdir()}!=expected:raise SystemExit('Acceptance plugin metadata inventory mismatch')
if (metadata/'manifest.json').read_bytes()!=manifest_raw:raise SystemExit('Acceptance plugin catalog mismatch')
font_hashes={}
for asset in manifest['assets']:
    if asset.get('postscript'):continue
    resource=metadata/asset['file']
    digest=hashlib.sha256(resource.read_bytes()).hexdigest()
    if resource.stat().st_size!=asset['size'] or digest!=asset['sha256']:
        raise SystemExit('Plugin font metadata mismatch: '+asset['file'])
    font_hashes[asset['file']]=digest
backend=plugin/'bin/notemd-sumi'
import subprocess
subprocess.run(['codesign','--verify','--strict',str(backend)],check=True)
exe=app/'Contents/MacOS'/info['CFBundleExecutable']
report={'app':str(app),'bundleId':info['CFBundleIdentifier'],'executableSha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'pluginFontMetadata':font_hashes,'backendSha256':hashlib.sha256(backend.read_bytes()).hexdigest(),'launched':False}
report['signature']=inspect(app,requested_identity())
(root/'tasks/sumi-native/host-acceptance/build-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
PY
