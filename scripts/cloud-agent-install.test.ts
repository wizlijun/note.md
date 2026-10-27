import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function harness(options: { existing?: boolean; corepack?: boolean; name?: string; dist?: boolean; manifest?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'notemd-cloud-install-'))
  roots.push(root)
  const repo = join(root, 'mdeditor'), core = join(root, 'moraya-core'), bin = join(root, 'bin'), log = join(root, 'calls')
  mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(bin)
  cpSync(resolve('scripts/cloud-agent-install.sh'), join(repo, 'scripts/cloud-agent-install.sh'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.7.0' }))
  // PATH contains only these fixtures and the read-only tools the script needs.
  // git, corepack, chown and sudo can never reach the actual machine/network.
  symlinkSync(process.execPath, join(bin, 'node'))
  for (const name of ['dirname', 'id']) symlinkSync(`/usr/bin/${name}`, join(bin, name))
  const seed = `fs.mkdirSync(p.join(core,'dist'),{recursive:true});
if(${options.manifest !== false})fs.writeFileSync(p.join(core,'package.json'),JSON.stringify({name:${JSON.stringify(options.name ?? '@moraya/core')}}));
if(${options.dist !== false})fs.writeFileSync(p.join(core,'dist/index.js'),'fixture-core');`
  function fake(name: string, body: string) {
    writeFileSync(join(bin, name), `#!${process.execPath}
const fs=require('fs'),p=require('path'),a=process.argv.slice(2),core=${JSON.stringify(core)};
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify([${JSON.stringify(name)},...a])+String.fromCharCode(10));
${body}
`, { mode: 0o755 })
  }
  fake('git', `if(a[0]!=='clone'||a.at(-1)!==core)process.exit(72);${seed}`)
  fake('sudo', 'process.exit(73)')
  fake('chown', '')
  if (options.corepack !== false) fake('corepack', "if(JSON.stringify(a)!==JSON.stringify(['pnpm','install','--frozen-lockfile']))process.exit(74)")
  if (options.existing) {
    mkdirSync(join(core, 'dist'), { recursive: true })
    if (options.manifest !== false) writeFileSync(join(core, 'package.json'), JSON.stringify({ name: options.name ?? '@moraya/core' }))
    if (options.dist !== false) writeFileSync(join(core, 'dist/index.js'), 'keep-existing-core')
  }
  return {
    core,
    calls: (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    run: () => spawnSync('/bin/bash', [join(repo, 'scripts/cloud-agent-install.sh')], {
      cwd: repo, encoding: 'utf8', env: { PATH: bin, TMPDIR: root },
    }),
  }
}

describe('Cloud Agent bootstrap (isolated command boundary)', () => {
  it('clones the sibling once then installs with the frozen lockfile', () => {
    const h = harness(), result = h.run()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(h.calls().filter(c => c[0] === 'git')).toEqual([
      ['git', 'clone', '--depth', '1', 'https://github.com/wizlijun/moraya-core.git', h.core],
    ])
    expect(h.calls().filter(c => c[0] === 'corepack')).toEqual([['corepack', 'pnpm', 'install', '--frozen-lockfile']])
    expect(h.calls().some(c => c[0] === 'sudo')).toBe(false)
  })

  it('reuses an existing sibling without pulling or replacing its build', () => {
    const h = harness({ existing: true }), result = h.run()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(h.calls()).toEqual([['corepack', 'pnpm', 'install', '--frozen-lockfile']])
    expect(readFileSync(join(h.core, 'dist/index.js'), 'utf8')).toBe('keep-existing-core')
  })

  it('fails clearly before cloning when corepack is unavailable', () => {
    const h = harness({ corepack: false }), result = h.run()
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toMatch(/corepack/i)
    expect(h.calls()).toEqual([])
    expect(existsSync(h.core)).toBe(false)
  })

  it.each([
    { existing: true, name: 'unrelated-package' },
    { existing: true, dist: false },
    { manifest: false },
  ])('rejects unusable core before dependency installation: %j', options => {
    const h = harness(options), result = h.run()
    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toMatch(/moraya|package|dist/i)
    expect(h.calls().some(c => c[0] === 'corepack')).toBe(false)
  })
})
