#!/usr/bin/env bash
set -euo pipefail

# Keep the core's checked-in dist; the host frontend is rebuilt below.
copy_source() {
  local source=$1 destination=$2
  mkdir -p "$destination"
  rsync -a \
    --exclude=node_modules --exclude=target --exclude=.git \
    --exclude=.pnpm-store --exclude=.cache --exclude=.wrangler \
    --exclude=.env\* --exclude=\*.p8 --exclude=\*.p12 --exclude=.dev.vars \
    --exclude=.superpowers --exclude=.worktrees --exclude=tasks \
    --exclude=.claude --exclude=.claire --exclude=dist-plugins \
    --exclude=dist-share-editor --exclude=.DS_Store \
    "$source/" "$destination/"
}

main() {
  local target=${1:-}
  case "$target" in
    aarch64-unknown-linux-gnu|x86_64-unknown-linux-gnu) ;;
    *) echo "unsupported Linux target: $target" >&2; return 2 ;;
  esac
  if [[ $# -ne 1 ]]; then
    echo "usage: linux-build.sh <Rust Linux GNU triple>" >&2
    return 2
  fi
  local native_target
  native_target=$(rustc -vV | sed -n 's/^host: //p')
  if [[ "$target" != "$native_target" ]]; then
    echo "target $target requires a matching native Docker platform (found $native_target)" >&2
    return 2
  fi
  [[ -f /input/mdeditor/package.json && -d /input/moraya-core/dist ]] || {
    echo "mount mdeditor and sibling moraya-core (including tracked dist) under /input" >&2
    return 1
  }
  # /build belongs to this disposable container; source mounts stay read-only.
  rm -rf /build/mdeditor /build/moraya-core
  copy_source /input/mdeditor /build/mdeditor
  copy_source /input/moraya-core /build/moraya-core
  rm -rf /build/mdeditor/dist
  cd /build/mdeditor
  export NOTEMD_DIST_CHANNEL=package-manager
  export CARGO_TARGET_DIR=/cache/target
  export pnpm_config_verify_deps_before_run=false
  export NOTEMD_EMPTY_ENV_DIR=/build/empty-env
  mkdir -p "$NOTEMD_EMPTY_ENV_DIR" /output
  # Use the declared channel without rustup downloading unrelated Apple/Windows
  # std targets from rust-toolchain.toml inside a Linux-only build container.
  RUSTUP_TOOLCHAIN=$(sed -n 's/^channel = "\(.*\)"/\1/p' src-tauri/rust-toolchain.toml)
  export RUSTUP_TOOLCHAIN
  rustup target add "$target"
  corepack pnpm install --frozen-lockfile
  rm -rf "$CARGO_TARGET_DIR/$target/release/bundle/deb"
  corepack pnpm tauri build --target "$target" --bundles deb
  local debs=("$CARGO_TARGET_DIR/$target/release/bundle/deb/"*.deb)
  [[ -f "${debs[0]}" ]] || { echo "Tauri produced no deb" >&2; return 1; }
  cp "${debs[@]}" /output/
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
