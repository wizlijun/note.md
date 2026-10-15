import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { validateRelease } from './release-publish-core.mjs'

const tag = 'v6.1015.1', version = '6.1015.1'
const base = `https://github.com/wizlijun/note.md/releases/download/${tag}/`
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const names = ['note.md-6.1015.1-aarch64.dmg', 'note.md-6.1015.1-x86_64.dmg',
    'note.md-aarch64.app.tar.gz', 'note.md-aarch64.app.tar.gz.sig',
    'note.md-x86_64.app.tar.gz', 'note.md-x86_64.app.tar.gz.sig',
    'note.md_6.1015.1_x64-setup.exe', 'note.md_6.1015.1_x64-setup.exe.sig',
    'note.md_6.1015.1_amd64.deb', 'note.md_6.1015.1_arm64.deb', 'SHA256SUMS-linux.txt', 'latest.json']
  const platforms = {
    'darwin-aarch64': { url: base + names[2], signature: 'signed-arm' },
    'darwin-x86_64': { url: base + names[4], signature: 'signed-intel' },
    'windows-x86_64': { url: base + names[6], signature: 'signed-win' },
  }
  const contents: Record<string, string> = {
    [names[3]]: 'signed-arm\n', [names[5]]: 'signed-intel\n', [names[7]]: 'signed-win\n',
    [names[8]]: 'amd64-deb', [names[9]]: 'arm64-deb',
    'SHA256SUMS-linux.txt': `${sha('amd64-deb')}  ${names[8]}\n${sha('arm64-deb')}  ${names[9]}\n`,
  }
  const latest: { version: string; platforms: Record<string, { url: string; signature: string }> } = { version, platforms }
  contents['latest.json'] = JSON.stringify(latest)
  const assets = names.map(name => ({ name, url: base + name, content: contents[name], sha256: sha(contents[name] || '') }))
  return { tag, draft: true, assets, latest, contents }
}

describe('draft publication gate', () => {
  it('accepts the exact macOS/Windows/Linux asset set produced by release scripts', () => {
    expect(() => validateRelease(fixture())).not.toThrow()
  })
  for (const name of fixture().assets.map(a => a.name)) {
    it(`refuses publication without ${name}`, () => {
      const input = fixture(); input.assets = input.assets.filter(a => a.name !== name)
      expect(() => validateRelease(input)).toThrow()
    })
  }
  for (const key of ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']) {
    it(`refuses publication without updater platform ${key}`, () => {
      const input = fixture(); delete input.latest.platforms[key as keyof typeof input.latest.platforms]
      expect(() => validateRelease(input)).toThrow()
    })
  }
  it.each(['linux-aarch64', 'linux-x86_64'])('rejects package-manager updater key %s', key => {
    const input = fixture(); Object.assign(input.latest.platforms, { [key]: { url: base + 'linux.deb', signature: 'sig' } })
    expect(() => validateRelease(input)).toThrow()
  })
  it.each(['constructor', '__proto__', 'unknown-platform'])('rejects unsupported own updater key %s', key => {
    const input = fixture(); Object.defineProperty(input.latest.platforms, key, { enumerable: true, value: { url: base + 'other', signature: 'sig' } })
    expect(() => validateRelease(input)).toThrow()
  })
  it('rejects published releases and mismatched manifest version', () => {
    expect(() => validateRelease({ ...fixture(), draft: false })).toThrow()
    const input = fixture(); input.latest.version = '6.1014.1'
    expect(() => validateRelease(input)).toThrow()
  })
  it('requires explicit Windows omission and rejects stale updater references to skipped Windows', () => {
    const input = fixture(); input.assets = input.assets.filter(a => !a.name.includes('setup.exe'))
    expect(() => validateRelease(input)).toThrow()
    expect(() => validateRelease({ ...input, without: 'windows' })).toThrow()
    delete input.latest.platforms['windows-x86_64']
    expect(() => validateRelease({ ...input, without: 'windows' })).not.toThrow()
  })
  it('allows Linux omission only when explicitly selected', () => {
    const input = fixture(); input.assets = input.assets.filter(a => !a.name.endsWith('.deb') && a.name !== 'SHA256SUMS-linux.txt')
    expect(() => validateRelease(input)).toThrow()
    expect(() => validateRelease({ ...input, without: 'linux' })).not.toThrow()
  })
  it.each(['old-tag', 'other-file', 'other-repository', 'signature'])('rejects updater %s drift', kind => {
    const input = fixture(), entry = input.latest.platforms['windows-x86_64']
    if (kind === 'old-tag') entry.url = entry.url.replace(tag, 'v6.1014.1')
    if (kind === 'other-file') entry.url = base + 'note.md-aarch64.app.tar.gz'
    if (kind === 'other-repository') entry.url = entry.url.replace('wizlijun', 'other')
    if (kind === 'signature') entry.signature = 'stale'
    expect(() => validateRelease(input)).toThrow()
  })
  it.each(['hash', 'filename', 'duplicate', 'missing'])('rejects Linux checksum %s corruption', kind => {
    const input = fixture(), asset = input.assets.find(a => a.name === 'SHA256SUMS-linux.txt')!
    if (kind === 'hash') asset.content = asset.content!.replace(sha('amd64-deb'), '0'.repeat(64))
    if (kind === 'filename') asset.content = asset.content!.replace('_arm64.deb', '_aarch64.deb')
    if (kind === 'duplicate') asset.content += asset.content
    if (kind === 'missing') asset.content = asset.content!.split('\n')[0]
    expect(() => validateRelease(input)).toThrow()
  })
})

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function harness(input = fixture(), prerelease = false, recheck = '') {
  const root = mkdtempSync(join(tmpdir(), 'notemd-publish-')); roots.push(root)
  writeFileSync(join(root, 'release.json'), JSON.stringify({ tagName: tag, isDraft: input.draft, isPrerelease: prerelease, assets: input.assets }))
  writeFileSync(join(root, 'contents.json'), JSON.stringify({ ...input.contents, 'latest.json': JSON.stringify(input.latest) }))
  const log = join(root, 'calls.jsonl')
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2),root=${JSON.stringify(root)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args.includes('view')) {const release=JSON.parse(fs.readFileSync(path.join(root,'release.json'))),second=fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(line=>line.includes('"view"')).length>1;if(second&&${JSON.stringify(recheck)}==='downloads')release.assets[0].downloadCount=7;if(second&&${JSON.stringify(recheck)}==='identity')release.assets[0].id='replacement';if(second&&${JSON.stringify(recheck)}==='published')release.isDraft=false;process.stdout.write(JSON.stringify(release));}
else if(args.includes('download')) {const name=args[args.indexOf('--pattern')+1],dir=args[args.indexOf('--dir')+1];const data=JSON.parse(fs.readFileSync(path.join(root,'contents.json')));if(!(name in data)) process.exit(7);fs.writeFileSync(path.join(dir,name),data[name]);}
else if(!args.includes('edit')) process.exit(8);
`)
  chmodSync(join(root, 'gh'), 0o755)
  return { root, log, run: (args: string[] = [tag]) => spawnSync('bash', [resolve('scripts/release-publish.sh'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: root + ':' + process.env.PATH }, input: '' }) }
}
function calls(log: string) { try { return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) } catch { return [] } }
describe('publish command boundary (fake network CLI, real gate)', () => {
  it('publishes a validated normal release as latest', () => {
    const h = harness(), result = h.run()
    expect(result.status, result.stderr).toBe(0)
    expect(calls(h.log).filter(c => c.includes('edit'))).toEqual([['-R', 'wizlijun/note.md', 'release', 'edit', tag, '--draft=false', '--latest']])
  })
  it('keeps prereleases off latest', () => {
    const h = harness(fixture(), true), result = h.run()
    expect(result.status, result.stderr).toBe(0)
    expect(calls(h.log).find(c => c.includes('edit'))).toContain('--latest=false')
  })
  it('allows download counters to change during verification', () => {
    const h = harness(fixture(), false, 'downloads'), result = h.run()
    expect(result.status, result.stderr).toBe(0)
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(true)
  })
  it.each(['identity', 'published'])('refuses publication if release %s changes during verification', change => {
    const h = harness(fixture(), false, change), result = h.run()
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(false)
  })
  it('never publishes invalid downloaded manifests or assets', () => {
    const input = fixture(); input.latest.version = 'old'
    const h = harness(input), result = h.run()
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('upload'))).toBe(false)
  })
  it('never publishes a non-draft', () => {
    const input = fixture(); input.draft = false
    const h = harness(input), result = h.run()
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('upload'))).toBe(false)
  })
  it.each([[tag, '--without', 'windows'], [tag, '--yes'], ['bad-tag'], [tag, '--without', 'macos']])('rejects noninteractive omissions or bad arguments %j before any mutation', (...args) => {
    const h = harness(), result = h.run(args)
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('upload'))).toBe(false)
  })
  it.each(['yes', 'v6.1014.1 without windows', `${tag} without linux`, `${tag} without windows`])('requires exact tag/platform interactive confirmation: %s', answer => {
    const input = fixture(); input.assets = input.assets.filter(a => !a.name.includes('setup.exe'))
    delete input.latest.platforms['windows-x86_64']
    const h = harness(input)
    const result = spawnSync('python3', ['-c', `
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen(['bash', sys.argv[1], sys.argv[2], '--without', 'windows'], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
sent = False
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    if select.select([master], [], [], .1)[0]:
        try: data = os.read(master, 65536)
        except OSError: break
        if not data: break
        output += data
        if b'Type exactly' in output and not sent:
            os.write(master, (sys.argv[3] + '\\n').encode()); sent = True
    if child.poll() is not None: break
if child.poll() is None: child.kill()
child.wait()
os.close(master)
sys.stdout.buffer.write(output)
sys.exit(child.returncode)
`, resolve('scripts/release-publish.sh'), tag, answer], { encoding: 'utf8', env: { ...process.env, PATH: h.root + ':' + process.env.PATH } })
    const accepted = answer === `${tag} without windows`
    expect(result.status === 0, result.stdout + result.stderr).toBe(accepted)
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(accepted)
  }, 20_000)
})
