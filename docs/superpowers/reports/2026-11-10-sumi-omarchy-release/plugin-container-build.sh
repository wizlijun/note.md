#!/usr/bin/env bash
# Runs in the Debian 12 builder. The prepare phase has network but no key;
# the package phase has the read-only original key but no network.
set -euo pipefail
mode=${1:?prepare or package}
source_sha=${2:?frozen source SHA}
export CARGO_BUILD_JOBS=2
export COREPACK_HOME=/cache/node/corepack
export PNPM_CONFIG_STORE_DIR=/cache/pnpm
export PNPM_CONFIG_CACHE_DIR=/cache/node/cache PNPM_CONFIG_STATE_DIR=/cache/node/state
export pnpm_config_verify_deps_before_run=false
export PNPM_CONFIG_FETCH_RETRIES=5 PNPM_CONFIG_FETCH_TIMEOUT=180000
export PNPM_CONFIG_NETWORK_CONCURRENCY=4
if [[ "$mode" == prepare ]]; then
  rm -rf /build/mdeditor /build/moraya-core
  mkdir -p /build/mdeditor /build/moraya-core
  tar -xf /input/source.tar -C /build/mdeditor
  tar -xf /input/core.tar -C /build/moraya-core
  # Store only the real frozen commit object, never the original .git/config or
  # credentials. The existing release script only needs rev-parse HEAD.
  git init -q /build/mdeditor
  actual_sha=$(git -C /build/mdeditor hash-object -t commit -w --stdin < /input/commit-object)
  [[ "$actual_sha" == "$source_sha" ]]
  git -C /build/mdeditor update-ref refs/heads/frozen "$source_sha"
  git -C /build/mdeditor symbolic-ref HEAD refs/heads/frozen
  ln -s /cache/target /build/mdeditor/plugins-src/write/backend/target
fi
cd /build/mdeditor
[[ "$(git rev-parse HEAD)" == "$source_sha" ]]
export RUSTUP_TOOLCHAIN
RUSTUP_TOOLCHAIN=$(sed -n 's/^channel = "\(.*\)"/\1/p' src-tauri/rust-toolchain.toml)
if [[ "$mode" == prepare ]]; then
  corepack pnpm install --frozen-lockfile
  cargo fetch --locked --manifest-path plugins-src/write/backend/Cargo.toml --target x86_64-unknown-linux-gnu
elif [[ "$mode" == package ]]; then
  export CARGO_NET_OFFLINE=true SUMI_RELEASE_TARGET=x86_64-unknown-linux-gnu
  export PATH="/tools/minisign/usr/bin:$PATH"
  export LD_LIBRARY_PATH=/tools/minisign/usr/lib/x86_64-linux-gnu
  export NOTEMD_PLUGIN_SIGNING_KEY=/run/secrets/notemd-plugins.key
  bash scripts/release-plugins.sh --release sumi
  mkdir -p /output/notemd.sumi/0.1.11
  cp dist-plugins/notemd.sumi/0.1.11/{x86_64-unknown-linux-gnu.notemdpkg,x86_64-unknown-linux-gnu.notemdpkg.minisig,manifest.json} /output/notemd.sumi/0.1.11/
  cp dist-plugins/notemd.sumi/0.1.11/native-x86_64-unknown-linux-gnu/notemd-sumi /output/notemd-sumi
  python3 scripts/sumi/verify-linux-binary.py /output/notemd-sumi --target x86_64-unknown-linux-gnu > /output/elf-verification.json
  readelf --version-info /output/notemd-sumi > /output/elf-symbol-versions.txt
  ldd -r /output/notemd-sumi > /output/ldd-debian12.txt 2>&1
  ! grep -Eq 'not found|undefined symbol' /output/ldd-debian12.txt
else
  echo "unknown phase" >&2
  exit 2
fi
