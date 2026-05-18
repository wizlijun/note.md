#!/usr/bin/env bash
#
# One-shot release helper for ExLibris.
#
#   scripts/release-exlibris.sh <version> [--draft] [--prerelease]
#
# Examples:
#   scripts/release-exlibris.sh 0.1.0
#   scripts/release-exlibris.sh 0.2.0 --draft
#
# Produces TWO independent per-arch macOS `.dmg`s: aarch64 (Apple Silicon)
# and x86_64 (Intel). Each architecture has its own .app bundle and dmg.
#
# Steps:
#   pre-flight → tests → bump versions
#   → for each arch in (aarch64, x86_64): signed per-arch build → notarize
#   → tag (exlibris-v<version>) → push → GitHub release (upload 2 dmg)
#
# ExLibris is independent of mdeditor's release cycle. v0.1.0 ships WITHOUT
# the tauri-plugin-updater (no auto-update story for first release). Add it
# in 0.1.1 when there's a prior version to migrate from.
#
# Environment (auto-loaded from `.env.release` in repo root if present):
#   APPLE_TEAM_ID         Apple Developer team id (shared with mdeditor)
#   APPLE_ID              App-Store-Connect Apple ID for notarization
#   APPLE_PASSWORD        App-specific password
#   GH_REPO               default: wizlijun/MdEditor (same repo, separate tag namespace)

set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env.release" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.release"
  set +a
fi

say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

VERSION="${1:-}"; shift || true
DRAFT=0; PRERELEASE=0
for arg in "$@"; do
  case "$arg" in
    --draft)      DRAFT=1      ;;
    --prerelease) PRERELEASE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version> [--draft] [--prerelease]" >&2
  exit 2
fi

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be semver X.Y.Z"

TAG="exlibris-v$VERSION"
GH_REPO="${GH_REPO:-wizlijun/MdEditor}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-T5G56DH47L}"

cd "$ROOT"

# ---------- pre-flight ----------

say "pre-flight (ExLibris $VERSION)"

git diff --quiet && git diff --cached --quiet \
  || die "working tree is dirty — commit or stash first"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "main" ]] || die "not on main (current: $BRANCH)"

git fetch origin main --quiet
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse '@{u}')
[[ "$LOCAL" == "$REMOTE" ]] || die "local main differs from origin/main — pull/push first"

git tag --list | grep -qx "$TAG" \
  && die "tag $TAG already exists locally"
git ls-remote --tags origin "refs/tags/$TAG" | grep -q . \
  && die "tag $TAG already exists on origin"

command -v pnpm  >/dev/null || die "pnpm not found"
command -v gh    >/dev/null || die "gh not found"
command -v cargo >/dev/null || die "cargo not found"

# Detach any leftover bundle_dmg.sh random-mount points
LEFTOVER_MOUNTS=$(ls -d /Volumes/dmg.* 2>/dev/null || true)
if [[ -n "$LEFTOVER_MOUNTS" ]]; then
  echo "    detaching stuck dmg mounts:"
  for m in $LEFTOVER_MOUNTS; do
    echo "      $m"
    hdiutil detach "$m" -force >/dev/null 2>&1 || true
  done
fi

# Signing identity
APPLE_SIGNING_IDENTITY=$(
  security find-identity -v -p codesigning \
    | awk -F\" -v t="$APPLE_TEAM_ID" '/Developer ID Application/ && index($0,"("t")") {print $2; exit}'
)
SIGNING_KIND="Developer ID Application"
if [[ -z "$APPLE_SIGNING_IDENTITY" ]]; then
  APPLE_SIGNING_IDENTITY=$(
    security find-identity -v -p codesigning \
      | awk -F\" -v t="$APPLE_TEAM_ID" '/Apple Distribution/ && index($0,"("t")") {print $2; exit}'
  )
  SIGNING_KIND="Apple Distribution (Gatekeeper will block direct downloads)"
fi
[[ -n "$APPLE_SIGNING_IDENTITY" ]] \
  || die "no Developer ID or Apple Distribution cert for team $APPLE_TEAM_ID in keychain"
echo "    signing as: $APPLE_SIGNING_IDENTITY"
echo "    cert kind:  $SIGNING_KIND"

NOTARIZE_OK=1
for var in APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [[ -z "${!var:-}" ]]; then
    NOTARIZE_OK=0
    printf '\033[1;33m!\033[0m notarization var %s not set\n' "$var" >&2
  fi
done
if (( NOTARIZE_OK )); then
  echo "    notarize:   yes (APPLE_ID=$APPLE_ID, team=$APPLE_TEAM_ID)"
else
  echo "    notarize:   no — first-launch Gatekeeper warning will appear"
fi

# ---------- tests ----------

say "running tests"
pnpm -s --filter exlibris test
( cd exlibris/src-tauri && cargo test --lib --quiet )

# ---------- bump versions ----------

say "bumping versions to $VERSION"

revert_bumps() {
  git checkout -- \
    exlibris/package.json \
    exlibris/src-tauri/tauri.conf.json \
    exlibris/src-tauri/Cargo.toml \
    exlibris/src-tauri/Cargo.lock 2>/dev/null || true
}
trap 'revert_bumps' ERR

python3 - "$VERSION" <<'PY'
import json, sys
v = sys.argv[1]
for p in ("exlibris/package.json", "exlibris/src-tauri/tauri.conf.json"):
    with open(p) as f: d = json.load(f)
    d["version"] = v
    with open(p, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
PY

sed -i '' "1,/^version = /s/^version = \"[^\"]*\"/version = \"$VERSION\"/" exlibris/src-tauri/Cargo.toml

grep -q "\"version\": \"$VERSION\""             exlibris/package.json              || die "bump failed: exlibris/package.json"
grep -q "\"version\": \"$VERSION\""             exlibris/src-tauri/tauri.conf.json || die "bump failed: exlibris/src-tauri/tauri.conf.json"
grep -q "^version = \"$VERSION\"$"              exlibris/src-tauri/Cargo.toml      || die "bump failed: exlibris/src-tauri/Cargo.toml"

# Refresh Cargo.lock to match the new version
( cd exlibris/src-tauri && cargo check --quiet )

# ---------- build ----------

say "building (signed)"

rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null 2>&1 || true

STAGED_ASSETS=()

build_arch() {
  local arch="$1" arch_tag="$2"
  say "building target $arch"
  ( cd exlibris && APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" pnpm tauri build --target "$arch" )

  local bundle="exlibris/src-tauri/target/$arch/release/bundle"
  local dmg_src
  dmg_src=$(find "$bundle/dmg" -maxdepth 1 -type f -name "*_${VERSION}_*.dmg" -print -quit)
  [[ -n "$dmg_src" && -f "$dmg_src" ]] || die "dmg not found for $arch in $bundle/dmg"

  local dmg_staged="/tmp/ExLibris-${VERSION}-${arch_tag}.dmg"
  cp "$dmg_src" "$dmg_staged"

  STAGED_ASSETS+=("$dmg_staged")
  echo "    ${arch_tag} done: dmg=$(du -h "$dmg_staged" | cut -f1)"
}

build_arch aarch64-apple-darwin aarch64
build_arch x86_64-apple-darwin  x86_64

# ---------- commit, tag, push ----------

say "committing $TAG"
trap - ERR
git add exlibris/package.json exlibris/src-tauri/tauri.conf.json \
        exlibris/src-tauri/Cargo.toml exlibris/src-tauri/Cargo.lock
git commit -m "chore(exlibris): release v$VERSION"
git tag -a "$TAG" -m "ExLibris $VERSION"

say "pushing to origin"
git push origin main
git push origin "$TAG"

# ---------- release ----------

say "creating GitHub release"

PREAMBLE=$(cat <<EOF
## ExLibris $VERSION — first release

ExLibris is an independent macOS app for managing an ebook library. Companion to M↓: shares the sotvault git-synced directory and launches from M↓'s tray menu.

## Install

Pick the dmg matching your Mac's chip:

- **Apple Silicon (M1/M2/M3/…):** \`ExLibris-${VERSION}-aarch64.dmg\`
- **Intel:** \`ExLibris-${VERSION}-x86_64.dmg\`

> Code-signed with Developer ID Application (\`$APPLE_TEAM_ID\`), hardened runtime, notarized.
> Requires M↓ 2.4.2+ (for the shared config integration). Calibre must be installed locally for ebook conversion.

EOF
)

GENERATED=$(
  gh api -X POST "repos/$GH_REPO/releases/generate-notes" \
    -f tag_name="$TAG" \
    -f target_commitish="main" \
    --jq .body 2>/dev/null \
  || true
)

NOTES="${PREAMBLE}${GENERATED}"

EXTRA=()
(( DRAFT ))      && EXTRA+=(--draft)
(( PRERELEASE )) && EXTRA+=(--prerelease)

gh -R "$GH_REPO" release create "$TAG" \
  --title "ExLibris $VERSION" \
  --notes "$NOTES" \
  "${EXTRA[@]}" \
  "${STAGED_ASSETS[@]}"

URL=$(gh -R "$GH_REPO" release view "$TAG" --json url -q .url)
printf '\033[1;32m✓\033[0m released: %s\n' "$URL"
