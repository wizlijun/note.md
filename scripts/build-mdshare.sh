#!/usr/bin/env bash
# Build the mdshare CLI for both macOS architectures and copy into the
# bundled plugin directory. Run before `pnpm tauri build` for release.
set -euo pipefail
cd "$(dirname "$0")/.."

# Prefer rustup-managed toolchain over any system Rust (e.g. Homebrew) that
# may be earlier in PATH and lack cross-compilation std libraries.
export PATH="$HOME/.cargo/bin:$PATH"

echo "[mdshare] ensuring rustup targets…"
rustup target add aarch64-apple-darwin >/dev/null
rustup target add x86_64-apple-darwin >/dev/null

echo "[mdshare] cargo build --release × 2…"
( cd mdshare && cargo build --release --target aarch64-apple-darwin )
( cd mdshare && cargo build --release --target x86_64-apple-darwin )

DEST="src-tauri/plugins/share"
mkdir -p "$DEST"
cp mdshare/target/aarch64-apple-darwin/release/mdshare "$DEST/bin-aarch64-apple-darwin"
cp mdshare/target/x86_64-apple-darwin/release/mdshare  "$DEST/bin-x86_64-apple-darwin"
chmod +x "$DEST"/bin-*-apple-darwin
strip      "$DEST"/bin-*-apple-darwin

# Codesign with hardened runtime + secure timestamp so Apple notarization
# accepts the binaries when they're embedded in the release .app bundle.
# Without this, notarization rejects with: "binary is not signed",
# "signature does not include a secure timestamp", "executable does not
# have the hardened runtime enabled".
#
# Identity discovery mirrors scripts/release.sh: prefer Developer ID
# Application matching APPLE_TEAM_ID (if set), else any Developer ID
# Application identity in the login keychain. If no Developer ID is
# available (e.g. running on a dev machine without release certs),
# skip signing — the binaries will be unsigned but usable for `pnpm
# tauri dev`. Notarization will fail at release.sh time with a clear
# error pointing back here.
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
  echo "[mdshare] codesign with: $SIGNING_IDENTITY"
  for b in "$DEST"/bin-*-apple-darwin; do
    codesign --force --options runtime --timestamp \
      --sign "$SIGNING_IDENTITY" "$b"
  done
else
  echo "[mdshare] WARNING: no Developer ID Application identity in keychain — binaries left unsigned (release.sh will fail notarization)"
fi

echo "[mdshare] binaries written:"
ls -lh "$DEST"/bin-*-apple-darwin
