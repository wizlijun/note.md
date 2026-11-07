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
python3 scripts/sumi/acceptance/prepare.py --install
python3 - <<'PY'
import json
from pathlib import Path
root=Path.cwd()
support=Path.home()/'Library/Application Support/net.notemd.sumi.acceptance'
expected=json.loads((root/'tasks/sumi-native/host-acceptance/seed/.sumi-acceptance.json').read_text())
if not support.is_dir() or json.loads((support/'.sumi-acceptance.json').read_text())!=expected:
    raise SystemExit('Install the reviewed unique seed using prepare.py --install before building; no launch will be attempted.')
settings=json.loads((support/'settings.json').read_text())
if settings.get('mcpServer',{}).get('enabled') is not False:raise SystemExit('Acceptance MCP must remain disabled')
PY
env RUSTUP_TOOLCHAIN=1.99.0 \
  SDKROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk \
  CARGO_TARGET_DIR="$sumi_repo/src-tauri/target" \
  CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_CODEGEN_UNITS=1 CARGO_INCREMENTAL=0 \
  ./node_modules/.bin/tauri build --debug --target aarch64-apple-darwin --features sumi-acceptance --bundles app --config "$sumi_repo/tasks/sumi-native/host-acceptance/tauri.acceptance.json"
python3 - <<'PY'
import hashlib,json,plistlib
from pathlib import Path
root=Path.cwd()
app=root/'src-tauri/target/aarch64-apple-darwin/debug/bundle/macos/note.md Sumi Acceptance.app'
info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
if info['CFBundleIdentifier']!='net.notemd.sumi.acceptance':raise SystemExit('Wrong bundle identifier; do not launch')
if info.get('CFBundleDocumentTypes'):raise SystemExit('Acceptance bundle must not register document associations')
schemes=[scheme for row in info.get('CFBundleURLTypes',[]) for scheme in row.get('CFBundleURLSchemes',[])]
if schemes!=['notemd-sumi-acceptance']:raise SystemExit('Unexpected acceptance URL schemes')
manifest=json.loads((root/'src-tauri/resources/sumi/manifest.json').read_text())
font_hashes={}
for asset in manifest['assets']:
    font=app/'Contents/Resources/resources/sumi'/asset['file']
    digest=hashlib.sha256(font.read_bytes()).hexdigest()
    if font.stat().st_size!=asset['size'] or digest!=asset['sha256']:
        raise SystemExit('Bundled font/license mismatch: '+asset['file'])
    font_hashes[asset['file']]=digest
exe=app/'Contents/MacOS'/info['CFBundleExecutable']
report={'app':str(app),'bundleId':info['CFBundleIdentifier'],'executableSha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'fontAssets':font_hashes,'launched':False}
(root/'tasks/sumi-native/host-acceptance/build-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
PY
codesign --verify --strict 'src-tauri/target/aarch64-apple-darwin/debug/bundle/macos/note.md Sumi Acceptance.app'
