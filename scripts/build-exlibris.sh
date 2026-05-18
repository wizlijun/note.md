#!/usr/bin/env bash
set -euo pipefail

# Build ExLibris for both macOS architectures, producing two per-arch dmgs.
# Mirrors the convention used for mdeditor.

cd "$(dirname "$0")/.."

pnpm --filter exlibris install

for triple in aarch64-apple-darwin x86_64-apple-darwin; do
  echo "==> Building ExLibris for $triple"
  pnpm --filter exlibris tauri build --target "$triple"
done

echo "==> Done. Artifacts:"
find exlibris/src-tauri/target/*/release/bundle/dmg -name "*.dmg" 2>/dev/null || true
