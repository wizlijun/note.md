#!/bin/sh
#
# Build Rust Code — hybrid script invoked by the Xcode "Build Rust Code" phase.
#
# Two modes:
#   1. Tauri-orchestrated: when launched by `pnpm tauri ios build` or
#      `pnpm tauri ios dev`, a local WebSocket server hands us the CLI
#      options. Preferred path; preserves frontend rebuild, config sync, etc.
#   2. Standalone fallback: when invoked by Xcode IDE Build directly (or
#      `xcodebuild` from CLI without Tauri), the WebSocket is absent and the
#      orchestrator panics with `ConnectionRefused`. We detect that and fall
#      back to a direct `cargo build` so Xcode IDE works for independent
#      debugging.
#
# Required Xcode env: PLATFORM_DISPLAY_NAME, ARCHS, CONFIGURATION, SRCROOT.

set -eu

# rustup-managed cargo (has iOS targets) must beat Homebrew cargo.
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

ERR_LOG=$(mktemp)
trap 'rm -f "$ERR_LOG"' EXIT

# --- Try Tauri orchestrator -------------------------------------------------
if pnpm tauri ios xcode-script -v \
    --platform "${PLATFORM_DISPLAY_NAME:?}" \
    --sdk-root "${SDKROOT:?}" \
    --framework-search-paths "${FRAMEWORK_SEARCH_PATHS:-}" \
    --header-search-paths "${HEADER_SEARCH_PATHS:-}" \
    --gcc-preprocessor-definitions "${GCC_PREPROCESSOR_DEFINITIONS:-}" \
    --configuration "${CONFIGURATION:?}" \
    ${FORCE_COLOR:-} "${ARCHS:?}" 2>"$ERR_LOG"; then
  cat "$ERR_LOG" >&2
  exit 0
fi

# Tauri exited non-zero. Only fall back if it's the WebSocket-refused panic;
# any other failure (cargo error, manifest issue, ...) should propagate as-is.
if ! grep -q "ConnectionRefused\|Connection refused" "$ERR_LOG"; then
  echo "[Build Rust Code] tauri ios xcode-script failed (not a fallback case):" >&2
  cat "$ERR_LOG" >&2
  exit 1
fi

echo "[Build Rust Code] Tauri orchestrator unavailable (no WebSocket), falling back to standalone cargo build" >&2

# --- Standalone fallback ----------------------------------------------------
case "${PLATFORM_DISPLAY_NAME:?}" in
  "iOS Simulator")
    case "${ARCHS:?}" in
      arm64)  TARGET="aarch64-apple-ios-sim" ;;
      x86_64) TARGET="x86_64-apple-ios" ;;
      *) echo "unsupported simulator arch: $ARCHS" >&2; exit 1 ;;
    esac ;;
  "iOS")
    TARGET="aarch64-apple-ios" ;;
  *)
    echo "unsupported platform: $PLATFORM_DISPLAY_NAME" >&2; exit 1 ;;
esac

case "${CONFIGURATION:?}" in
  Release|release) PROFILE_FLAG="--release"; PROFILE_DIR="release" ;;
  *)               PROFILE_FLAG="";          PROFILE_DIR="debug"   ;;
esac

# SRCROOT = src-tauri/gen/apple; cargo manifest lives at src-tauri/Cargo.toml
# SRCROOT = src-tauri/gen/apple → climb 2 levels to src-tauri/
SRC_TAURI=$(cd "${SRCROOT}/../.." && pwd)

# shellcheck disable=SC2086
(cd "$SRC_TAURI" && cargo build $PROFILE_FLAG --target "$TARGET" --lib)

SRC="${SRC_TAURI}/target/${TARGET}/${PROFILE_DIR}/libmdeditor_lib.a"
DST_DIR="${SRCROOT}/Externals/${ARCHS}/${CONFIGURATION}"

if [ ! -f "$SRC" ]; then
  echo "[Build Rust Code] expected static lib not found: $SRC" >&2
  echo "[Build Rust Code] available artifacts:" >&2
  ls -la "${SRC_TAURI}/target/${TARGET}/${PROFILE_DIR}/" 2>&1 | sed 's/^/  /' >&2
  exit 1
fi

mkdir -p "$DST_DIR"
cp "$SRC" "$DST_DIR/libapp.a"

echo "[Build Rust Code] standalone build complete: $DST_DIR/libapp.a"
