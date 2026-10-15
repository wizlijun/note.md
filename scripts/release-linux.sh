#!/usr/bin/env bash
# Build a frozen draft's Debian 12 packages. Never changes tags/versions/latest.json.
set -euo pipefail
die() { echo "Linux release: $*" >&2; exit 1; }
[[ $# -eq 1 && "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die 'usage: release-linux.sh <vX.Y.Z>'
TAG=$1 VERSION=${1#v}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
GH_REPO=${GH_REPO:-wizlijun/note.md}
[[ "$GH_REPO" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || die 'invalid GH_REPO'
for tool in git node docker gh tar; do command -v "$tool" >/dev/null || die "$tool is required"; done
RELEASE=$(gh -R "$GH_REPO" release view "$TAG" --json tagName,isDraft)
node -e 'const r=JSON.parse(process.argv[1]); if(r.tagName!==process.argv[2]||r.isDraft!==true)throw Error("exact existing draft required")' "$RELEASE" "$TAG"
COMMIT=$(git -C "$ROOT" rev-parse --verify "refs/tags/$TAG^{commit}")
REMOTE_COMMIT=$(gh api "repos/$GH_REPO/commits/$TAG" --jq .sha)
[[ "$REMOTE_COMMIT" == "$COMMIT" ]] || die 'local tag commit differs from the remote release tag'
CORE=$(cd "$ROOT/../moraya-core" && pwd)
CORE_COMMIT=$(git -C "$CORE" rev-parse --verify HEAD)
echo "Frozen Linux source: tag=$TAG commit=$COMMIT core=$CORE_COMMIT"
TMP=$(mktemp -d)
WORKTREE="$TMP/tag-worktree"
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -d "$WORKTREE" ]]; then git -C "$ROOT" worktree remove --force "$WORKTREE" || echo "warning: failed to remove $WORKTREE" >&2; fi
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
git -C "$ROOT" worktree add --quiet --detach "$WORKTREE" "$COMMIT"
node - "$WORKTREE" "$VERSION" <<'NODE'
const fs = require('fs'), path = require('path'), [root, version] = process.argv.slice(2)
for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
  if (JSON.parse(fs.readFileSync(path.join(root, file))).version !== version) throw Error(`${file} tag/version mismatch`)
}
const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8').split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0]
if (cargo?.match(/^version\s*=\s*"([^"]+)"/m)?.[1] !== version) throw Error('Cargo.toml tag/version mismatch')
NODE

# git archive freezes only committed content. Exclusions apply at every depth,
# before any container/context mount; host worktree caches and credentials never enter.
archive_source() {
  local source=$1 commit=$2 destination=$3 pattern
  local excludes=()
  for pattern in '.env*' '.git' 'node_modules' 'target' '.pnpm-store' '.cache' \
    '.superpowers' '.worktrees' '.wrangler' '.dev.vars*' '.npmrc' '.netrc' \
    '.ssh' '.aws' '.gnupg' 'credentials*' '*.p8' '*.p12' '*.pem' '*.key'; do
    excludes+=(":(exclude,glob)**/$pattern" ":(exclude,glob)**/$pattern/**")
  done
  mkdir -p "$destination"
  git -C "$source" archive "$commit" -- . "${excludes[@]}" | tar -x -C "$destination"
}
INPUT="$TMP/input"
archive_source "$WORKTREE" "$COMMIT" "$INPUT/mdeditor"
archive_source "$CORE" "$CORE_COMMIT" "$INPUT/moraya-core"
[[ -d "$INPUT/moraya-core/dist" ]] || die 'frozen sibling core must contain tracked dist'
OUTPUT="$TMP/output"
mkdir -p "$OUTPUT"
for ARCH in amd64 arm64; do
  case "$ARCH" in amd64) TRIPLE=x86_64-unknown-linux-gnu ;; arm64) TRIPLE=aarch64-unknown-linux-gnu ;; esac
  IMAGE="notemd-linux-build:$ARCH"
  docker build --platform "linux/$ARCH" -t "$IMAGE" \
    -f "$INPUT/mdeditor/scripts/docker/linux-build.Dockerfile" "$INPUT/mdeditor"
  mkdir -p "$OUTPUT/$ARCH"
  docker run --rm --platform "linux/$ARCH" \
    --mount "type=bind,src=$INPUT/mdeditor,dst=/input/mdeditor,readonly" \
    --mount "type=bind,src=$INPUT/moraya-core,dst=/input/moraya-core,readonly" \
    --mount "type=bind,src=$OUTPUT/$ARCH,dst=/output" \
    --mount "type=volume,src=notemd-linux-$ARCH-registry,dst=/usr/local/cargo/registry" \
    --mount "type=volume,src=notemd-linux-$ARCH-git,dst=/usr/local/cargo/git" \
    --mount "type=volume,src=notemd-linux-$ARCH-target,dst=/cache/target" \
    --mount "type=volume,src=notemd-linux-$ARCH-pnpm,dst=/cache/pnpm" \
    --mount "type=volume,src=notemd-linux-$ARCH-node,dst=/cache/node" \
    -e COREPACK_HOME=/cache/node/corepack \
    -e PNPM_CONFIG_STORE_DIR=/cache/pnpm \
    -e PNPM_CONFIG_CACHE_DIR=/cache/node/cache -e PNPM_CONFIG_STATE_DIR=/cache/node/state \
    -e PNPM_CONFIG_FETCH_RETRIES=5 -e PNPM_CONFIG_FETCH_TIMEOUT=180000 \
    -e PNPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 -e PNPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    -e PNPM_CONFIG_NETWORK_CONCURRENCY=4 \
    "$IMAGE" "$TRIPLE"
  DEB="$OUTPUT/$ARCH/note.md_${VERSION}_${ARCH}.deb"
  [[ -f "$DEB" ]] || die "missing exact package $DEB"
  "$ROOT/scripts/release-linux-verify.sh" "$DEB" "$VERSION" "$ARCH"
done

STAGED="$TMP/staged"
mkdir -p "$STAGED"
for ARCH in amd64 arm64; do cp "$OUTPUT/$ARCH/note.md_${VERSION}_${ARCH}.deb" "$STAGED/"; done
node - "$STAGED" "$VERSION" <<'NODE'
const fs = require('fs'), path = require('path'), crypto = require('crypto'), [root, version] = process.argv.slice(2)
const sums = ['amd64', 'arm64'].map(arch => {
  const name = `note.md_${version}_${arch}.deb`
  return `${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')}  ${name}\n`
}).join('')
fs.writeFileSync(path.join(root, 'SHA256SUMS-linux.txt'), sums)
NODE
# Recheck the draft after long builds; no remote mutation happens before this.
RELEASE=$(gh -R "$GH_REPO" release view "$TAG" --json tagName,isDraft)
node -e 'const r=JSON.parse(process.argv[1]); if(r.tagName!==process.argv[2]||r.isDraft!==true)throw Error("draft changed before upload")' "$RELEASE" "$TAG"
gh -R "$GH_REPO" release upload "$TAG" \
  "$STAGED/note.md_${VERSION}_amd64.deb" "$STAGED/note.md_${VERSION}_arm64.deb" \
  "$STAGED/SHA256SUMS-linux.txt" --clobber
echo "Uploaded verified Linux packages to draft $TAG; publish separately with release-publish.sh"
