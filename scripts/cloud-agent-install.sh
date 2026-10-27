#!/usr/bin/env bash
# Cloud Agent bootstrap for note.md.
#
# The desktop app depends on the private editor core `@moraya/core`, wired in
# package.json as `file:../moraya-core`. That package lives in a *sibling*
# checkout (github.com/wizlijun/moraya-core) which is not part of this repo, so
# `pnpm install` fails with `ENOENT ... /moraya-core` until it is present. This
# script clones it next to the repo, then installs the workspace from the
# frozen lockfile. Reruns reuse the sibling without changing its checkout.
set -euo pipefail

if ! command -v corepack >/dev/null 2>&1; then
  echo "[install] corepack is required to use the packageManager pinned in package.json" >&2
  exit 1
fi

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
  echo "[install] reusing existing moraya-core checkout without pulling"
else
  echo "[install] cloning moraya-core"
  run_priv git clone --depth 1 "$MORAYA_REPO" "$MORAYA_DIR"
  # Make the sibling owned by the current user so pnpm can link into it.
  run_priv chown -R "$(id -u):$(id -g)" "$MORAYA_DIR"
fi

# Reject an unrelated or unbuilt sibling before installing local dependencies.
node - "$MORAYA_DIR" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const directory = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
if (pkg.name !== '@moraya/core' || !fs.existsSync(path.join(directory, 'dist/index.js'))) {
  console.error('[install] expected a built @moraya/core checkout with dist/index.js')
  process.exit(1)
}
NODE

cd "$REPO_ROOT"
echo "[install] pnpm install --frozen-lockfile"
corepack pnpm install --frozen-lockfile

echo "[install] done"
