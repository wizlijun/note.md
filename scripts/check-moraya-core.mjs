#!/usr/bin/env node
// Gate: the Rich editor runs on the sibling `../moraya-core` checkout
// (`"@moraya/core": "file:../moraya-core"`), which is not version-pinned. A
// stale checkout silently ships old editing behaviour — e.g. select-all +
// Delete in a note with front matter refused with `semantic-mismatch` because
// core predated ac79ae4/1722a6d. This check makes that drift a hard stop.
//
//   node scripts/check-moraya-core.mjs [--core <dir>] [--host <dir>] [--require <commit>]
//
// Checks, in order:
//   1. the core checkout contains REQUIRED_CORE_COMMIT (bump it whenever host
//      code or tests start depending on a newer core);
//   2. the core's tracked `dist/` has no uncommitted build output (macOS builds
//      read the working tree, Linux release builds `git archive` HEAD — they
//      must agree);
//   3. the host's installed `node_modules/@moraya/core/dist` is byte-identical
//      to the checkout's `dist/` (`pnpm sync:core` copies it).
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** moraya-core origin/main verified against the full host test suite. */
export const REQUIRED_CORE_COMMIT = '1722a6dedec8ee79e7a6ff046e7eeafb7187102e'

function git(dir, ...args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
}

function digests(root) {
  const out = new Map()
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else out.set(relative(root, path), createHash('sha256').update(readFileSync(path)).digest('hex'))
    }
  }
  walk(root)
  return out
}

/** @returns {string[]} problems; empty means the core is in sync. */
export function checkMorayaCore({ core, host, required = REQUIRED_CORE_COMMIT }) {
  const problems = []
  if (!existsSync(join(core, '.git'))) return [`${core} is not a moraya-core git checkout`]
  const has = git(core, 'cat-file', '-e', `${required}^{commit}`)
  if (has.status !== 0) problems.push(`moraya-core does not have required commit ${required.slice(0, 7)} — run: git -C ${core} pull`)
  else if (git(core, 'merge-base', '--is-ancestor', required, 'HEAD').status !== 0)
    problems.push(`moraya-core HEAD is behind required commit ${required.slice(0, 7)} — run: git -C ${core} pull`)
  const dirty = git(core, 'status', '--porcelain', '--', 'dist').stdout.trimEnd()
  if (dirty) problems.push(`moraya-core dist/ has uncommitted build output (HEAD dist and working tree differ):\n${dirty}`)
  const coreDist = join(core, 'dist')
  const installed = join(host, 'node_modules', '@moraya', 'core')
  if (!existsSync(coreDist)) problems.push(`${coreDist} is missing`)
  else if (!existsSync(installed)) problems.push(`${installed} is missing — run: pnpm install`)
  else {
    const want = digests(coreDist), got = digests(join(realpathSync(installed), 'dist'))
    const differing = [...new Set([...want.keys(), ...got.keys()])].filter(file => want.get(file) !== got.get(file))
    if (differing.length) problems.push(`node_modules/@moraya/core/dist differs from ${coreDist} (${differing.length} file(s), e.g. ${differing.slice(0, 3).join(', ')}) — run: pnpm sync:core`)
  }
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const host = resolve(opt('--host') ?? '.')
  const core = resolve(opt('--core') ?? join(host, '..', 'moraya-core'))
  const problems = checkMorayaCore({ core, host, required: opt('--require') ?? REQUIRED_CORE_COMMIT })
  if (problems.length) {
    console.error(`moraya-core is out of sync:\n- ${problems.join('\n- ')}`)
    process.exit(1)
  }
  console.log(`moraya-core ok (${git(core, 'rev-parse', '--short', 'HEAD').stdout.trim()})`)
}
