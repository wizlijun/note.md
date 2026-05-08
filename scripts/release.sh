#!/usr/bin/env bash
#
# One-shot release helper for M↓.
#
#   scripts/release.sh <version> [--universal] [--draft] [--prerelease]
#
# Examples:
#   scripts/release.sh 0.1.1
#   scripts/release.sh 0.2.0 --universal
#   scripts/release.sh 0.2.0-rc1 --prerelease    # not supported (semver only)
#
# Steps:
#   pre-flight → tests → bump versions → signed build → tag → push → GitHub release
#
# Environment (auto-loaded from `.env.release` in repo root if present):
#   APPLE_TEAM_ID   default: T5G56DH47L (Wuhan Fulin). Used to locate the
#                   signing identity in the login keychain. Order of preference:
#                   "Developer ID Application" → "Apple Distribution".
#   APPLE_ID            App-Store-Connect Apple ID for notarization.
#   APPLE_PASSWORD      App-specific password (not the actual Apple ID password).
#   GH_REPO         default: wizlijun/MdEditor
#
# When all three notarization vars are set AND the signing cert is Developer ID,
# Tauri's bundler runs `notarytool` automatically and the resulting .dmg passes
# Gatekeeper on first launch. Missing any var → unsigned/uninspected → user
# sees the "unidentified developer" warning.

set -euo pipefail

# Prefer rustup-managed rustc/cargo so cross-compile targets resolve.
# Some macs have Homebrew rust earlier in PATH which lacks the alternate-arch
# std libraries (causes E0463 "can't find crate for `core`" during the
# x86_64 leg of universal builds).
export PATH="$HOME/.cargo/bin:$PATH"

# ---------- load secrets (kept out of git) ----------

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env.release" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env.release"
  set +a
fi

# ---------- args ----------

VERSION="${1:-}"; shift || true
UNIVERSAL=0; DRAFT=0; PRERELEASE=0
for arg in "$@"; do
  case "$arg" in
    --universal)  UNIVERSAL=1  ;;
    --draft)      DRAFT=1      ;;
    --prerelease) PRERELEASE=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "usage: $0 <version> [--universal] [--draft] [--prerelease]" >&2
  exit 2
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "version must be x.y.z (got: $VERSION)" >&2
  exit 2
fi

TAG="v$VERSION"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-T5G56DH47L}"
GH_REPO="${GH_REPO:-wizlijun/MdEditor}"

cd "$ROOT"

say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- pre-flight ----------

say "pre-flight"

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

# Detach any leftover bundle_dmg.sh random-mount points from previous failed
# runs. They show up as /Volumes/dmg.XXXXXX. Tauri's dmg packaging step
# (bundle_dmg.sh) silently fails if a conflicting mount exists.
LEFTOVER_MOUNTS=$(ls -d /Volumes/dmg.* 2>/dev/null || true)
if [[ -n "$LEFTOVER_MOUNTS" ]]; then
  echo "    detaching stuck dmg mounts:"
  for m in $LEFTOVER_MOUNTS; do
    echo "      $m"
    hdiutil detach "$m" -force >/dev/null 2>&1 || true
  done
fi

# Signing identity — prefer Developer ID Application (Gatekeeper-friendly when
# notarized) and fall back to Apple Distribution (App-Store-only; never passes
# Gatekeeper for direct downloads even with notarization).
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

# Notarization triplet — Tauri's bundler picks these up automatically. Missing
# any one → bundler skips notarization and prints a warning. We surface it
# here so the user sees it before a 5-minute build instead of after.
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
if (( NOTARIZE_OK )) && [[ "$SIGNING_KIND" != "Developer ID Application" ]]; then
  printf '\033[1;33m!\033[0m notarization vars set but cert is %s; notarization may still fail\n' "$SIGNING_KIND" >&2
fi

# ---------- tests ----------

say "running tests"
pnpm -s test

# ---------- bump versions ----------

say "bumping versions to $VERSION"

revert_bumps() {
  git checkout -- \
    package.json \
    src-tauri/tauri.conf.json \
    src-tauri/Cargo.toml \
    src-tauri/Cargo.lock 2>/dev/null || true
}
trap 'revert_bumps' ERR

python3 - "$VERSION" <<'PY'
import json, sys
v = sys.argv[1]
for p in ("package.json", "src-tauri/tauri.conf.json"):
    with open(p) as f: d = json.load(f)
    d["version"] = v
    with open(p, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
PY

# Cargo.toml: only the [package] version line at the top
sed -i '' "1,/^version = /s/^version = \"[^\"]*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml

grep -q "\"version\": \"$VERSION\""             package.json              || die "bump failed: package.json"
grep -q "\"version\": \"$VERSION\""             src-tauri/tauri.conf.json || die "bump failed: tauri.conf.json"
grep -q "^version = \"$VERSION\"$"              src-tauri/Cargo.toml      || die "bump failed: Cargo.toml"

# ---------- build ----------

say "building (signed)"

say "building mdshare plugin binaries"
pnpm build:mdshare

say "building md2pdf plugin binaries"
pnpm build:md2pdf

if (( UNIVERSAL )); then
  rustup target add x86_64-apple-darwin aarch64-apple-darwin >/dev/null 2>&1 || true
  APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" pnpm tauri build --target universal-apple-darwin
  DMG_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
  ARCH_TAG="universal"
else
  APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" pnpm tauri build
  DMG_DIR="src-tauri/target/release/bundle/dmg"
  case "$(uname -m)" in
    arm64)  ARCH_TAG="aarch64" ;;
    x86_64) ARCH_TAG="x86_64"  ;;
    *) die "unknown arch: $(uname -m)" ;;
  esac
fi

DMG_PATH=$(find "$DMG_DIR" -maxdepth 1 -type f -name "*_${VERSION}_${ARCH_TAG}.dmg" -print -quit)
[[ -n "$DMG_PATH" && -f "$DMG_PATH" ]] || die "dmg not found in $DMG_DIR"

ASSET_NAME="MdEditor-${VERSION}-${ARCH_TAG}.dmg"
STAGED="/tmp/$ASSET_NAME"
cp "$DMG_PATH" "$STAGED"
echo "    built: $STAGED ($(du -h "$STAGED" | cut -f1))"

# ---------- commit, tag, push ----------

say "committing v$VERSION"
trap - ERR  # build succeeded — keep version bumps even if a later step fails
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
# build-mdshare.sh re-signs the bundled plugin binaries every run (timestamps
# change), so working tree picks up modifications. Include them in the release
# commit so HEAD matches what shipped and the next run sees a clean tree.
git add src-tauri/plugins/share/bin-aarch64-apple-darwin \
        src-tauri/plugins/share/bin-x86_64-apple-darwin \
        src-tauri/plugins/md2pdf/bin-aarch64-apple-darwin \
        src-tauri/plugins/md2pdf/bin-x86_64-apple-darwin 2>/dev/null || true
git commit -m "chore: release v$VERSION"
git tag -a "$TAG" -m "M↓ $VERSION"

say "pushing to origin"
git push origin main
git push origin "$TAG"

# ---------- release ----------

say "creating GitHub release"

PREAMBLE=$(cat <<EOF
## Install

Download \`$ASSET_NAME\` below.

> Code-signed with Apple Distribution (\`$APPLE_TEAM_ID\`), hardened runtime, **not notarized**.
> First launch shows a Gatekeeper warning — right-click the app → **Open** → confirm. Required only once.

EOF
)

# Auto-generate "What's Changed" body from the GitHub API and prepend the install preamble.
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
  --title "M↓ $VERSION" \
  --notes "$NOTES" \
  "${EXTRA[@]}" \
  "$STAGED"

URL=$(gh -R "$GH_REPO" release view "$TAG" --json url -q .url)
printf '\033[1;32m✓\033[0m released: %s\n' "$URL"
