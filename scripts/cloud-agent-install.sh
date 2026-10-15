#!/usr/bin/env bash
# Cloud Agent bootstrap for note.md.
#
# The desktop app depends on the private editor core `@moraya/core`, wired in
# package.json as `file:../moraya-core`. That package lives in a *sibling*
# checkout (github.com/wizlijun/moraya-core) which is not part of this repo, so
# `pnpm install` fails with `ENOENT ... /moraya-core` until it is present. This
# script clones it next to the repo, then installs the workspace from the
# frozen lockfile. It is idempotent: reruns refresh the sibling and re-run a
# fast, no-op install.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARENT_DIR="$(dirname "$REPO_ROOT")"
MORAYA_DIR="$PARENT_DIR/moraya-core"
MORAYA_REPO="https://github.com/wizlijun/moraya-core.git"

# `sudo` is only needed when the repo sits directly under a root-owned dir
# (e.g. checkout at /workspace makes the sibling /moraya-core). Fall back to a
# plain clone when the parent is already writable.
run_priv() {
  if [ -w "$PARENT_DIR" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo "$@"
  else
    "$@"
  fi
}

echo "[install] repo:   $REPO_ROOT"
echo "[install] sibling: $MORAYA_DIR"

if [ -e "$MORAYA_DIR/package.json" ]; then
  echo "[install] moraya-core already present; refreshing (best-effort)"
  git -C "$MORAYA_DIR" pull --ff-only >/dev/null 2>&1 || \
    echo "[install] pull skipped (offline or diverged) — using existing checkout"
else
  echo "[install] cloning moraya-core"
  run_priv git clone --depth 1 "$MORAYA_REPO" "$MORAYA_DIR"
  # Make the sibling owned by the current user so pnpm can link into it.
  run_priv chown -R "$(id -u):$(id -g)" "$MORAYA_DIR"
fi

# Pin the package manager declared in package.json without depending on a
# globally pre-installed pnpm.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[install] enabling corepack for pnpm"
  corepack enable >/dev/null 2>&1 || true
fi

cd "$REPO_ROOT"
echo "[install] pnpm install --frozen-lockfile"
corepack pnpm install --frozen-lockfile

echo "[install] done"
