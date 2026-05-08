#!/usr/bin/env bash
# Build the md2pdf CLI for both macOS architectures and copy into the
# bundled plugin directory. Run before `pnpm tauri build` for release.
set -euo pipefail
cd "$(dirname "$0")/.."

# Prefer rustup-managed toolchain over any system Rust (e.g. Homebrew) that
# may be earlier in PATH and lack cross-compilation std libraries.
export PATH="$HOME/.cargo/bin:$PATH"

echo "[md2pdf] ensuring rustup targets…"
rustup target add aarch64-apple-darwin >/dev/null
rustup target add x86_64-apple-darwin >/dev/null

echo "[md2pdf] cargo build --release × 2…"
( cd md2pdf && cargo build --release --target aarch64-apple-darwin )
( cd md2pdf && cargo build --release --target x86_64-apple-darwin )

DEST="src-tauri/plugins/md2pdf"
mkdir -p "$DEST"
cp md2pdf/target/aarch64-apple-darwin/release/md2pdf "$DEST/bin-aarch64-apple-darwin"
cp md2pdf/target/x86_64-apple-darwin/release/md2pdf  "$DEST/bin-x86_64-apple-darwin"
chmod +x "$DEST"/bin-*-apple-darwin
strip      "$DEST"/bin-*-apple-darwin

# Codesign with hardened runtime + secure timestamp so Apple notarization
# accepts the binaries when they're embedded in the release .app bundle.
# Without this, notarization rejects with: "binary is not signed",
# "signature does not include a secure timestamp", "executable does not
# have the hardened runtime enabled".
APPLE_TEAM_ID="${APPLE_TEAM_ID:-T5G56DH47L}"
SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY=$(
    security find-identity -v -p codesigning \
      | awk -F\" -v t="$APPLE_TEAM_ID" '/Developer ID Application/ && index($0,"("t")") {print $2; exit}'
  ) || true
fi
if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY=$(
    security find-identity -v -p codesigning \
      | awk -F\" '/Developer ID Application/ {print $2; exit}'
  ) || true
fi
if [[ -n "$SIGNING_IDENTITY" ]]; then
  echo "[md2pdf] codesign with: $SIGNING_IDENTITY"
  for b in "$DEST"/bin-*-apple-darwin; do
    codesign --force --options runtime --timestamp \
      --sign "$SIGNING_IDENTITY" "$b"
  done
else
  echo "[md2pdf] WARNING: no Developer ID Application identity in keychain — binaries left unsigned (release.sh will fail notarization)"
fi

echo "[md2pdf] binaries written:"
ls -lh "$DEST"/bin-*-apple-darwin
