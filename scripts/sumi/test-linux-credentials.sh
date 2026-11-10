#!/usr/bin/env bash
# Compile the production credential module without the GUI dependency graph.
# The optional roundtrip uses a private bus and temporary keyring, never the
# desktop session's Secret Service. Requires libsecret and (for roundtrip)
# dbus-run-session + gnome-keyring-daemon.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
case "${1:-}" in
  '') roundtrip=false ;;
  --private-keyring) roundtrip=true ;;
  *) printf 'Usage: %s [--private-keyring]\n' "$0" >&2; exit 2 ;;
esac
if [[ $(uname -s) != Linux ]]; then
  printf 'This test requires Linux.\n' >&2; exit 2
fi
fixture_root=$(mktemp -d -t sumi-credentials.XXXXXXXX)
trap 'rm -rf -- "$fixture_root"' EXIT
mkdir -p "$fixture_root/src"
cat > "$fixture_root/Cargo.toml" <<'MANIFEST'
[package]
name = "sumi-linux-credentials-tests"
version = "0.0.0"
edition = "2021"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
uuid = { version = "1", features = ["v4"] }
tempfile = "3"
MANIFEST
python3 - "$repo_root" "$fixture_root" <<'PY'
import json, pathlib, sys
repo, fixture = map(pathlib.Path, sys.argv[1:])
source = json.dumps(str(repo / 'src-tauri/src/sumi/credentials.rs'), ensure_ascii=False)
(fixture / 'src/lib.rs').write_text('pub mod sumi {\n #[path = ' + source + ']\n pub mod credentials;\n}\n')
PY
# Keep the compilation cache outside the disposable fixture; constrain parallel
# jobs so this acceptance check can coexist with a full host build.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$repo_root/tasks/sumi-credentials-target}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
cargo test --offline --manifest-path "$fixture_root/Cargo.toml" -- --nocapture
if $roundtrip; then
  command -v dbus-run-session >/dev/null
  command -v gnome-keyring-daemon >/dev/null
  cargo test --offline --manifest-path "$fixture_root/Cargo.toml" --no-run --message-format=json > "$fixture_root/build.jsonl"
  test_binary=$(python3 - "$fixture_root/build.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    message = json.loads(line)
    if message.get('profile', {}).get('test') and message.get('executable'):
        print(message['executable']); break
else:
    raise SystemExit('credential test executable not found')
PY
)
  mkdir -m 700 "$fixture_root/data" "$fixture_root/runtime" "$fixture_root/control"
  # Remove inherited desktop endpoints so an unexpected unlock prompt cannot
  # reach the real compositor. Only this temporary bus can see the daemon.
  env -u DISPLAY -u WAYLAND_DISPLAY -u GNOME_KEYRING_CONTROL \
    XDG_DATA_HOME="$fixture_root/data" XDG_RUNTIME_DIR="$fixture_root/runtime" \
    dbus-run-session -- bash -euc '
      printf "%s" "isolated-sumi-test-password" | gnome-keyring-daemon --unlock --components=secrets --control-directory "$2/control"
      "$1" --exact sumi::credentials::tests::isolated_keychain_roundtrip --ignored --nocapture
    ' -- "$test_binary" "$fixture_root"
fi
