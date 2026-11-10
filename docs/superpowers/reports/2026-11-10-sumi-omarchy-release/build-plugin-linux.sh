#!/usr/bin/env bash
# Builds only: no R2/KV writes. Uses a frozen archive and isolated Docker caches.
set -euo pipefail
[[ $# == 3 ]] || { echo 'usage: build-plugin-linux.sh TAG SOURCE_SHA CORE_SHA' >&2; exit 2; }
tag=$1 source_sha=$2 core_sha=$3
[[ "$tag" == v6.1110.2 && "$source_sha" =~ ^[0-9a-f]{40}$ && "$core_sha" =~ ^[0-9a-f]{40}$ ]]
repo_root=$(git rev-parse --show-toplevel)
core_root=$(cd "$repo_root/../moraya-core" && pwd)
[[ "$(git rev-parse "$tag^{commit}")" == "$source_sha" ]]
[[ "$(git -C "$core_root" rev-parse "$core_sha^{commit}")" == "$core_sha" ]]
here=$(cd "$(dirname "$0")" && pwd)
source "$repo_root/tasks/omarchy-build/rootless/environment.sh"
build_root="$repo_root/tasks/sumi-plugin-release-0.1.11"
mkdir -p "$build_root/input" "$build_root/output"
archive_source() {
  local repository=$1 commit=$2 destination=$3 pattern path
  local excludes=()
  # Same source-safe exclusions as release-linux.sh; do not exclude Rust
  # credentials.rs/credentials_linux.rs by a broad credentials* pattern.
  for pattern in '.env*' '.git' 'node_modules' 'target' '.pnpm-store' '.cache' \
    '.superpowers' '.worktrees' '.wrangler' '.dev.vars*' '.npmrc' '.netrc' \
    '.ssh' '.aws' '.gnupg' '*.p8' '*.p12' '*.pem' '*.key'; do
    excludes+=(":(exclude,glob)**/$pattern" ":(exclude,glob)**/$pattern/**")
  done
  excludes+=(':(exclude,glob)**/credentials*/**')
  git -C "$repository" ls-tree -r --name-only -z "$commit" > "$destination.paths"
  while IFS= read -r -d '' path; do
    case "${path##*/}" in
      credentials*.rs) ;;
      credentials*) excludes+=(":(exclude,literal)$path") ;;
    esac
  done < "$destination.paths"
  rm "$destination.paths"
  git -C "$repository" archive "$commit" -- . "${excludes[@]}" > "$destination"
}
archive_source "$repo_root" "$source_sha" "$build_root/input/source.tar"
archive_source "$core_root" "$core_sha" "$build_root/input/core.tar"
git cat-file commit "$source_sha" > "$build_root/input/commit-object"
[[ "$(git hash-object -t commit --stdin < "$build_root/input/commit-object")" == "$source_sha" ]]
cp "$here/plugin-container-build.sh" "$build_root/input/build.sh"
image_before=$(docker image inspect notemd-linux-build:amd64 --format '{{.Id}}')
cat > "$build_root/input/Dockerfile.plugin" <<'DOCKER'
FROM notemd-linux-build:amd64
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
DOCKER
docker build --platform linux/amd64 -t notemd-sumi-plugin-tools:debian12 -f "$build_root/input/Dockerfile.plugin" "$build_root/input"
[[ "$(docker image inspect notemd-linux-build:amd64 --format '{{.Id}}')" == "$image_before" ]]
image=$(docker image inspect notemd-sumi-plugin-tools:debian12 --format '{{.Id}}')
python3 - "$build_root" "$tag" "$source_sha" "$core_sha" "$image_before" "$image" <<'PY'
import sys,json,hashlib
from pathlib import Path
root=Path(sys.argv[1])
proof=dict(zip(['tag','sourceCommit','coreCommit','baseImage','buildImage'],sys.argv[2:]))
proof.update(archiveSha256={name:hashlib.sha256((root/'input'/name).read_bytes()).hexdigest() for name in ['source.tar','core.tar','commit-object','build.sh']},cargoJobs=2,networkDuringSigning=False,privateKeyIncludedInImage=False)
(root/'build-inputs.json').write_text(json.dumps(proof,indent=2)+'\n')
PY
mounts=(--platform linux/amd64 --entrypoint bash
  --mount "type=bind,src=$build_root/input,dst=/input,readonly"
  --mount "type=bind,src=$build_root/output,dst=/output"
  --mount type=volume,src=notemd-sumi-plugin-build,dst=/build
  --mount type=volume,src=notemd-sumi-plugin-registry,dst=/usr/local/cargo/registry
  --mount type=volume,src=notemd-sumi-plugin-git,dst=/usr/local/cargo/git
  --mount type=volume,src=notemd-sumi-plugin-target,dst=/cache/target
  --mount type=volume,src=notemd-sumi-plugin-pnpm,dst=/cache/pnpm
  --mount type=volume,src=notemd-sumi-plugin-node,dst=/cache/node)
docker run --rm "${mounts[@]}" "$image" /input/build.sh prepare "$source_sha"
docker run --rm --network none "${mounts[@]}" \
  --mount "type=bind,src=$repo_root/tasks/omarchy-build/minisign-tool,dst=/tools/minisign,readonly" \
  --mount "type=bind,src=$repo_root/tasks/sumi-release-private/notemd-plugins.key,dst=/run/secrets/notemd-plugins.key,readonly" \
  "$image" /input/build.sh package "$source_sha"
echo "Frozen signed Linux plugin package: $build_root/output/notemd.sumi/0.1.11/x86_64-unknown-linux-gnu.notemdpkg"
