#!/usr/bin/env bash
# Dev-install the md2pdf v2 plugin into the local app-data plugins root.
# Builds for the CURRENT architecture only (fast dev loop); use
# scripts/build-md2pdf-v2.sh for the dual-arch release binaries.
# Usage: scripts/dev-install-plugin.sh [--release]
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE=debug; [[ "${1:-}" == "--release" ]] && PROFILE=release
( cd md2pdf && cargo build $([ "$PROFILE" = release ] && echo --release) --bins )
VERSION=$(node -e "console.log(require('./md2pdf/manifest.v2.json').version)")
ROOT="$HOME/Library/Application Support/net.notemd.app/plugins"
DEST="$ROOT/notemd.md2pdf/$VERSION"
mkdir -p "$DEST/bin"
cp md2pdf/target/$PROFILE/md2pdf "$DEST/bin/"
cp md2pdf/target/$PROFILE/md2pdf-v2 "$DEST/bin/"
cp md2pdf/manifest.v2.json "$DEST/manifest.json"
ln -sfn "$VERSION" "$ROOT/notemd.md2pdf/current"
node -e "
const fs=require('fs');const p='$ROOT/state.json';
const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{installed:{}};
s.installed['notemd.md2pdf']={version:'$VERSION',enabled:true};
fs.writeFileSync(p,JSON.stringify(s,null,2)+'\n');
"
echo "✓ installed notemd.md2pdf@$VERSION ($PROFILE, $(uname -m)) → $DEST"
echo "  enable the v2 runtime:  \"plugins_v2.enabled\": true in settings.json, or NOTEMD_PLUGINS_V2=1"
echo "  disable the v1 plugin:  \"plugins.enabled.md2pdf\": false in settings.json (avoids double File-menu entries)"

# ---------------------------------------------------------------------------
# Manual E2E walkthrough (plugin-runtime-v2 plan, Task 12 Step 3):
#   1. scripts/dev-install-plugin.sh
#   2. NOTEMD_PLUGINS_V2=1 pnpm tauri dev
#   3. File menu shows "Export to PDF (v2)…" → export an .md tab → PDF
#      written + success toast (emitted by the plugin via plugin-toast).
#   4. CLI: `notemd pdf2 x.md` (dev CLI, same flag) → PDF appears next to x.md.
#   5. Export again immediately → the long-running v2 process is reused.
#   6. Wait 120 s idle (idle_shutdown_seconds) → process exits; export once
#      more → lazy re-activation works.
# Automated fallback coverage lives in the Task 5/6/11 integration tests.
# ---------------------------------------------------------------------------
