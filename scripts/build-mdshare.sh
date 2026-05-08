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

echo "[mdshare] binaries written:"
ls -lh "$DEST"/bin-*-apple-darwin
