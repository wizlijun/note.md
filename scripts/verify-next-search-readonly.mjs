#!/usr/bin/env node
// Keyless macOS integration check against installed harness sandboxes and CLI.
// Usage: node scripts/verify-next-search-readonly.mjs /absolute/notemd /absolute/codex /absolute/dsh-install
// dsh-install is the directory containing dsh's package.json and node_modules.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'darwin', 'This verification uses the installed macOS sandboxes')
const [notemd, codex, dshInstall] = process.argv.slice(2)
assert(notemd && codex && dshInstall, 'Provide absolute notemd, codex, and dsh installation paths')
const requireDsh = createRequire(join(resolve(dshInstall), 'package.json'))
const { Context } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/cordis')).href)
const { LocalSandboxProvider } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-sandbox-local')).href)
const ctx = new Context()
const vault = mkdtempSync(join(tmpdir(), 'notemd-next-search-readonly-'))
const source = '---\ntitle: Search verification\n---\n\nKickoffNeedleAlpha related context.\n'
const evidence = []
function run(argv) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: vault, encoding: 'utf8', timeout: 30_000 })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  return result
}
try {
  writeFileSync(join(vault, 'sample.md'), source)
  await ctx.plugin(LocalSandboxProvider, {})
  const sandboxes = [
    ['Codex', argv => [codex, 'sandbox', '-P', ':read-only', '-C', vault, '--', ...argv]],
    ['DeepSeek', argv => {
      const wrapped = ctx.sandbox.confine(argv, { mode: 'read-only', workspaceRoot: vault })
      assert.equal(wrapped.enforcement, 'full')
      return wrapped.argv
    }],
  ]
  for (const [provider, confine] of sandboxes) {
    const search = run(confine([notemd, 'search', 'KickoffNeedleAlpha', '--vault', vault, '--json']))
    assert.equal(search.status, 0, `${provider}: ${search.stderr}`)
    const output = JSON.parse(search.stdout)
    assert.equal(output.route, 't1-scan', 'A fresh, unwritable index must fall back to direct scanning')
    assert.equal(output.total, 1)
    assert.equal(output.hits[0].path, 'sample.md')
    assert.match(search.stderr, /scanning files directly/)
    const denied = run(confine([process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "forbidden")', join(vault, 'forbidden.md')]))
    assert.notEqual(denied.status, 0, `${provider}: Vault writes must remain denied`)
    assert.deepEqual(readdirSync(vault), ['sample.md'])
    assert.equal(readFileSync(join(vault, 'sample.md'), 'utf8'), source)
    evidence.push({ provider, search_exit: search.status, route: output.route, hits: output.total, vault_write_denied: true, vault_unchanged: true })
  }
  console.log(JSON.stringify({ verified_at: new Date().toISOString(), evidence }, null, 2))
} finally {
  await ctx.fiber.dispose()
  rmSync(vault, { recursive: true, force: true })
}
