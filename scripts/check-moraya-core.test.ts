import { afterEach, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
// @ts-expect-error plain .mjs script without declarations
import { checkMorayaCore } from './check-moraya-core.mjs'

const temporary: string[] = []
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const git = (dir: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw Error(r.stderr)
  return r.stdout.trim()
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'moraya-core-check-')); temporary.push(root)
  const core = join(root, 'moraya-core'), host = join(root, 'host')
  mkdirSync(join(core, 'dist'), { recursive: true }); writeFileSync(join(core, 'dist', 'index.js'), 'v1')
  git(root, 'init', '-q', core); git(core, 'add', '.'); git(core, 'commit', '-qm', 'one')
  const first = git(core, 'rev-parse', 'HEAD')
  writeFileSync(join(core, 'dist', 'index.js'), 'v2'); git(core, 'commit', '-qam', 'two')
  const second = git(core, 'rev-parse', 'HEAD')
  const installed = join(host, 'node_modules', '@moraya', 'core')
  mkdirSync(installed, { recursive: true }); cpSync(join(core, 'dist'), join(installed, 'dist'), { recursive: true })
  return { core, host, installed, first, second }
}

it('accepts a core at or past the required commit with clean, synced dist', () => {
  const f = fixture()
  expect(checkMorayaCore({ core: f.core, host: f.host, required: f.first })).toEqual([])
  expect(checkMorayaCore({ core: f.core, host: f.host, required: f.second })).toEqual([])
})

it('rejects a core behind the required commit or missing it', () => {
  const f = fixture()
  git(f.core, 'checkout', '-q', f.first)
  cpSync(join(f.core, 'dist'), join(f.installed, 'dist'), { recursive: true })
  expect(checkMorayaCore({ core: f.core, host: f.host, required: f.second }).join()).toMatch(/behind required commit/)
  expect(checkMorayaCore({ core: f.core, host: f.host, required: 'f'.repeat(40) }).join()).toMatch(/does not have required commit/)
})

it('rejects uncommitted dist output and an unsynced installed copy', () => {
  const f = fixture()
  writeFileSync(join(f.core, 'dist', 'index.js'), 'local build')
  const problems = checkMorayaCore({ core: f.core, host: f.host, required: f.first }).join('\n')
  expect(problems).toMatch(/uncommitted build output/)
  expect(problems).toMatch(/differs from .*pnpm sync:core/)
})
