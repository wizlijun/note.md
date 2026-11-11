import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { validateRelease, validateCompanionMetadata } from './release-publish-core.mjs'

const tag = 'v6.1015.2', version = '6.1015.2'
const base = `https://github.com/wizlijun/note.md/releases/download/${tag}/`
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const companionFilename = 'Faitc5-for-Sumi-0.5.0.13-arm64.pkg'
const companionBytes = 'exact-approved-faitc5-package'
function approvedCompanion() {
  return { schema: 1, product: 'Faitc5 for Sumi', version: '0.5.0.13', platform: 'darwin-aarch64',
    filename: companionFilename, sha256: sha(companionBytes), bytes: Buffer.byteLength(companionBytes),
    sourceCommit: 'a'.repeat(40), appNotarized: true, packageSigned: false }
}
function fixture() {
  const names = ['note.md-6.1015.2-aarch64.dmg', 'note.md-6.1015.2-x86_64.dmg',
    'note.md-aarch64.app.tar.gz', 'note.md-aarch64.app.tar.gz.sig',
    'note.md-x86_64.app.tar.gz', 'note.md-x86_64.app.tar.gz.sig',
    'note.md_6.1015.2_x64-setup.exe', 'note.md_6.1015.2_x64-setup.exe.sig',
    'note.md_6.1015.2_amd64.deb', 'note.md_6.1015.2_arm64.deb', 'SHA256SUMS-linux.txt', 'latest.json', 'faitc5-companion.json', companionFilename]
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
  contents['faitc5-companion.json'] = JSON.stringify(approvedCompanion())
  contents[companionFilename] = companionBytes
  const assets = names.map(name => ({ name, url: base + name, content: contents[name], sha256: sha(contents[name] || ''), bytes: Buffer.byteLength(contents[name] || '') }))
  return { tag, approvedCompanion: approvedCompanion(), draft: true, url: `https://github.com/wizlijun/note.md/releases/tag/${tag}`, assets, latest, contents }
}

function armFixture() {
  const input = fixture()
  input.assets = input.assets.filter(a => a.name.includes('aarch64') || a.name === 'latest.json' || a.name === 'faitc5-companion.json' || a.name === companionFilename)
  delete input.latest.platforms['darwin-x86_64']
  delete input.latest.platforms['windows-x86_64']
  return input
}

function linuxFixture() {
  const input = fixture()
  input.assets = input.assets.filter(a => a.name.endsWith('.deb') || a.name === 'SHA256SUMS-linux.txt')
  return { ...input, latest: undefined }
}

describe('explicit Linux-only publication', () => {
  it('requires the explicit mode and its complete package-manager asset set', () => {
    expect(() => validateRelease(linuxFixture())).toThrow()
    expect(() => validateRelease({ ...linuxFixture(), linuxOnly: true })).not.toThrow()
    expect(() => validateRelease({ ...fixture(), linuxOnly: true })).toThrow()
  })
  for (const { name } of linuxFixture().assets) {
    it(`requires ${name}`, () => {
      const input = linuxFixture(); input.assets = input.assets.filter(a => a.name !== name)
      expect(() => validateRelease({ ...input, linuxOnly: true })).toThrow()
    })
  }
  it.each([{ without: 'windows' }, { without: 'linux' }, { macArm64Only: true }])('rejects incompatible mode %j', other => {
    expect(() => validateRelease({ ...linuxFixture(), linuxOnly: true, ...other })).toThrow()
  })
  it.each(['latest.json', 'note.md-aarch64.app.tar.gz', 'note.md_6.1015.2_x64-setup.exe'])('rejects non-Linux asset %s', name => {
    const input = linuxFixture(); input.assets.push(fixture().assets.find(a => a.name === name)!)
    expect(() => validateRelease({ ...input, linuxOnly: true })).toThrow()
  })
  it('rejects an updater manifest even when supplied without its asset', () => {
    expect(() => validateRelease({ ...linuxFixture(), latest: fixture().latest, linuxOnly: true })).toThrow()
  })
  it.each(['hash', 'old-tag', 'other-repository', 'wrong-checksum-url'])('rejects package evidence drift: %s', kind => {
    const input = linuxFixture(), deb = input.assets.find(a => a.name.endsWith('_amd64.deb'))!
    if (kind === 'hash') deb.sha256 = '0'.repeat(64)
    if (kind === 'old-tag') deb.url = deb.url.replace(tag, 'v6.1014.1')
    if (kind === 'other-repository') deb.url = deb.url.replace('/note.md/', '/other/')
    if (kind === 'wrong-checksum-url') input.assets.find(a => a.name === 'SHA256SUMS-linux.txt')!.url += '?download=1'
    expect(() => validateRelease({ ...input, linuxOnly: true })).toThrow()
  })
  it('rejects an already published release', () => {
    expect(() => validateRelease({ ...linuxFixture(), draft: false, linuxOnly: true })).toThrow()
  })
})

describe('explicit Apple Silicon-only publication', () => {
  it('requires the explicit mode and accepts only its complete asset set', () => {
    expect(() => validateRelease(armFixture())).toThrow()
    expect(() => validateRelease({ ...armFixture(), macArm64Only: true })).not.toThrow()
    expect(() => validateRelease({ ...fixture(), macArm64Only: true })).toThrow()
    expect(() => validateRelease({ ...armFixture(), macArm64Only: true, without: 'linux' })).toThrow()
  })
  for (const { name } of armFixture().assets) {
    it(`still requires ${name}`, () => {
      const input = armFixture(); input.assets = input.assets.filter(a => a.name !== name)
      expect(() => validateRelease({ ...input, macArm64Only: true })).toThrow()
    })
  }
  it.each(['darwin-x86_64', 'windows-x86_64', 'linux-aarch64'])('rejects omitted platform %s even with an old valid URL', platform => {
    const input = armFixture()
    input.latest.platforms[platform] = { url: base.replace(tag, 'v6.1014.1') + 'old.tar.gz', signature: 'old-signature' }
    expect(() => validateRelease({ ...input, macArm64Only: true })).toThrow()
  })
  it.each(['old-tag', 'signature'])('still rejects ARM updater %s drift', kind => {
    const input = armFixture(), entry = input.latest.platforms['darwin-aarch64']
    if (kind === 'old-tag') entry.url = entry.url.replace(tag, 'v6.1014.1')
    else entry.signature = 'stale'
    expect(() => validateRelease({ ...input, macArm64Only: true })).toThrow()
  })
})

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

// The URL shape is captured from the real v6.1015.2 draft gh response.
const draftSlug = 'untagged-a2fb6bea037b48551500'
const draftBase = `https://github.com/wizlijun/note.md/releases/download/${draftSlug}/`
function draftFixture() {
  const input = fixture()
  input.url = `https://github.com/wizlijun/note.md/releases/tag/${draftSlug}`
  input.assets.forEach(asset => { asset.url = draftBase + asset.name })
  return input
}

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function harness(input: ReturnType<typeof fixture> | ReturnType<typeof linuxFixture> = fixture(), prerelease = false, recheck = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'notemd-publish-'))); roots.push(root)
  writeFileSync(join(root, 'release.json'), JSON.stringify({ tagName: tag, isDraft: input.draft, isPrerelease: prerelease, url: input.url, assets: input.assets }))
  writeFileSync(join(root, 'contents.json'), JSON.stringify({ ...input.contents, 'latest.json': JSON.stringify(input.latest) }))
  mkdirSync(join(root, 'scripts/release-companions'), { recursive: true })
  for (const name of ['release-publish.sh', 'release-publish-core.mjs']) copyFileSync(resolve('scripts', name), join(root, 'scripts', name))
  writeFileSync(join(root, 'scripts/release-companions/faitc5.json'), JSON.stringify(input.approvedCompanion))
  const script = join(root, 'scripts/release-publish.sh')
  const log = join(root, 'calls.jsonl')
  writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const fs=require('fs'),path=require('path'),args=process.argv.slice(2),root=${JSON.stringify(root)};
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if(args.includes('view')) {const release=JSON.parse(fs.readFileSync(path.join(root,'release.json'))),second=fs.readFileSync(${JSON.stringify(log)},'utf8').split('\\n').filter(line=>line.includes('"view"')).length>1;if(second&&${JSON.stringify(recheck)}==='downloads')release.assets[0].downloadCount=7;if(second&&${JSON.stringify(recheck)}==='identity')release.assets[0].id='replacement';if(second&&${JSON.stringify(recheck)}==='published')release.isDraft=false;if(second&&${JSON.stringify(recheck)}==='draft-url')release.url=release.url.replace('a2fb6bea037b48551500','bbbbbbbbbbbbbbbbbbbb');process.stdout.write(JSON.stringify(release));}
else if(args.includes('download')) {const name=args[args.indexOf('--pattern')+1],dir=args[args.indexOf('--dir')+1];const data=JSON.parse(fs.readFileSync(path.join(root,'contents.json')));if(!(name in data)) process.exit(7);fs.writeFileSync(path.join(dir,name),data[name]);}
else if(!args.includes('edit')) process.exit(8);
`)
  chmodSync(join(root, 'gh'), 0o755)
  return { root, log, script, run: (args: string[] = [tag]) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, PATH: root + ':' + process.env.PATH }, input: '' }) }
}
function calls(log: string) { try { return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) } catch { return [] } }
function runInteractive(h: ReturnType<typeof harness>, args: string[], answer: string) {
  return spawnSync('python3', ['-c', `
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen(['bash', sys.argv[1], sys.argv[2]] + sys.argv[4:], stdin=slave, stdout=slave, stderr=slave)
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
`, h.script, tag, answer, ...args], { encoding: 'utf8', env: { ...process.env, PATH: h.root + ':' + process.env.PATH } })
}
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
  it.each([[tag, '--linux-only'], [tag, '--linux-only', '--mac-arm64-only'], [tag, '--linux-only', '--without', 'windows'], [tag, '--mac-arm64-only'], [tag, '--mac-arm64-only', '--without', 'linux'], [tag, '--without', 'windows'], [tag, '--yes'], ['bad-tag'], [tag, '--without', 'macos']])('rejects noninteractive omissions or bad arguments %j before any mutation', (...args) => {
    const h = harness(), result = h.run(args)
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('upload'))).toBe(false)
  })
  it.each([
    ...['yes', 'v6.1014.1 without windows', `${tag} without linux`, `${tag} without windows`].map(answer => ({ answer, arm: false })),
    ...['yes', `${tag} without windows`, 'v6.1014.1 mac-arm64-only', `${tag} mac-arm64-only`].map(answer => ({ answer, arm: true })),
  ])('requires exact tag/platform interactive confirmation: %j', ({ answer, arm }) => {
    const input = arm ? armFixture() : draftFixture()
    if (!arm) {
      input.assets = input.assets.filter(a => !a.name.includes('setup.exe'))
      delete input.latest.platforms['windows-x86_64']
    }
    const h = harness(input)
    const result = runInteractive(h, arm ? ['--mac-arm64-only'] : ['--without', 'windows'], answer)
    const accepted = answer === (arm ? `${tag} mac-arm64-only` : `${tag} without windows`)
    expect(result.status === 0, result.stdout + result.stderr).toBe(accepted)
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(accepted)
    if (arm) expect(calls(h.log).filter(c => c.includes('download')).map(c => c[c.indexOf('--pattern') + 1])).toEqual(['latest.json', 'note.md-aarch64.app.tar.gz.sig', 'faitc5-companion.json', companionFilename])
  }, 20_000)
})


describe('actual GitHub untagged draft URL boundary', () => {
  it('validates captured draft asset URLs while using only the exact requested tag for gh calls', () => {
    const h = harness(draftFixture()), result = h.run()
    expect(result.status, result.stderr).toBe(0)
    const issued = calls(h.log)
    expect(issued.filter(c => c.includes('edit'))).toEqual([['-R', 'wizlijun/note.md', 'release', 'edit', tag, '--draft=false', '--latest']])
    for (const call of issued) {
      for (const action of ['view', 'download', 'edit']) {
        const index = call.indexOf(action)
        if (index >= 0) expect(call[index + 1]).toBe('v6.1015.2')
      }
    }
    expect(issued.filter(c => c.includes('view')).every(c => c[c.indexOf('--json') + 1].split(',').includes('url'))).toBe(true)
  })

  it('accepts a mix of canonical final-tag and same-draft asset URLs', () => {
    const input = draftFixture(); input.assets[0].url = base + input.assets[0].name
    const h = harness(input), result = h.run()
    expect(result.status, result.stderr).toBe(0)
  })

  it.each([
    ['other draft', 'https://github.com/wizlijun/note.md/releases/download/untagged-bbbbbbbbbbbbbbbbbbbb/'],
    ['other repository', 'https://github.com/wizlijun/other/releases/download/untagged-a2fb6bea037b48551500/'],
    ['other owner', 'https://github.com/other/note.md/releases/download/untagged-a2fb6bea037b48551500/'],
    ['old tag', 'https://github.com/wizlijun/note.md/releases/download/v6.1015.1/'],
    ['other host', 'https://example.com/wizlijun/note.md/releases/download/untagged-a2fb6bea037b48551500/'],
    ['HTTP', 'http://github.com/wizlijun/note.md/releases/download/untagged-a2fb6bea037b48551500/'],
  ])('refuses an asset from %s before any download or mutation', (_, maliciousBase) => {
    const input = draftFixture(); input.assets.find(a => a.name === 'latest.json')!.url = maliciousBase + 'latest.json'
    const h = harness(input), result = h.run()
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('download'))).toBe(false)
  })

  it.each(['?download=1', '#fragment', '/extra-path'])('refuses asset URL suffix %s', suffix => {
    const input = draftFixture(); input.assets.find(a => a.name === 'latest.json')!.url += suffix
    const h = harness(input), result = h.run()
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('download'))).toBe(false)
  })

  it.each([
    '',
    `http://github.com/wizlijun/note.md/releases/tag/${draftSlug}`,
    `https://example.com/wizlijun/note.md/releases/tag/${draftSlug}`,
    `https://github.com/other/note.md/releases/tag/${draftSlug}`,
    `https://github.com/wizlijun/other/releases/tag/${draftSlug}`,
    `https://github.com/wizlijun/note.md/releases/tag/${draftSlug}?query=1`,
    `https://github.com/wizlijun/note.md/releases/tag/${draftSlug}#fragment`,
    `https://github.com/wizlijun/note.md/releases/tag/${draftSlug}/extra`,
    'https://github.com/wizlijun/note.md/releases/tag/v6.1015.1',
    'https://github.com/wizlijun/note.md/releases/tag/not-a-draft-slug',
    `https://github.com@evil.test/wizlijun/note.md/releases/tag/${draftSlug}`,
  ])('rejects malformed or mismatched release HTML URL %s', url => {
    // Canonical assets ensure this cannot pass just by rejecting draft URLs.
    const input = fixture(); input.url = url
    const h = harness(input), result = h.run()
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('download'))).toBe(false)
  })

  it('refuses draft-page identity changes before publication', () => {
    const h = harness(draftFixture(), false, 'draft-url'), result = h.run()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('release changed during validation')
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(false)
  })

  it('still rejects an updater manifest referencing the draft-only URL', () => {
    const input = draftFixture(); input.latest.platforms['darwin-aarch64'].url = draftBase + 'note.md-aarch64.app.tar.gz'
    const h = harness(input), result = h.run()
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(false)
  })
})

describe('Linux-only command boundary (fake network CLI, real downloaded bytes)', () => {
  it.each([false, true])('publishes exact Linux assets without changing latest, prerelease=%s', prerelease => {
    const h = harness(linuxFixture(), prerelease), result = runInteractive(h, ['--linux-only'], `${tag} linux-only`)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const issued = calls(h.log)
    expect(issued.filter(c => c.includes('edit'))).toEqual([['-R', 'wizlijun/note.md', 'release', 'edit', tag, '--draft=false', '--latest=false']])
    expect(issued.filter(c => c.includes('download')).map(c => c[c.indexOf('--pattern') + 1])).toEqual(['SHA256SUMS-linux.txt', `note.md_${version}_amd64.deb`, `note.md_${version}_arm64.deb`])
  }, 20_000)
  it('accepts only the matching GitHub draft slug and rechecks it before publication', () => {
    const input = linuxFixture(); input.url = `https://github.com/wizlijun/note.md/releases/tag/${draftSlug}`
    input.assets.forEach(asset => { asset.url = draftBase + asset.name })
    const h = harness(input), result = runInteractive(h, ['--linux-only'], `${tag} linux-only`)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(calls(h.log).filter(c => c.includes('view'))).toHaveLength(2)
  }, 20_000)
  it.each(['yes', 'v6.1014.1 linux-only', `${tag} mac-arm64-only`])('rejects nonmatching confirmation %s', answer => {
    const h = harness(linuxFixture()), result = runInteractive(h, ['--linux-only'], answer)
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(false)
  }, 20_000)
  it.each(['bytes', 'checksum', 'missing', 'url', 'latest'])('never publishes invalid Linux-only evidence: %s', drift => {
    const input = linuxFixture(), name = `note.md_${version}_amd64.deb`
    if (drift === 'bytes') input.contents[name] = 'different-downloaded-bytes'
    if (drift === 'checksum') input.contents['SHA256SUMS-linux.txt'] = input.contents['SHA256SUMS-linux.txt'].replace(sha('amd64-deb'), '0'.repeat(64))
    if (drift === 'missing') input.assets = input.assets.filter(a => a.name !== name)
    if (drift === 'url') input.assets[0].url = input.assets[0].url.replace(tag, 'v6.1014.1')
    if (drift === 'latest') input.assets.push(fixture().assets.find(a => a.name === 'latest.json')!)
    const h = harness(input), result = runInteractive(h, ['--linux-only'], `${tag} linux-only`)
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('upload'))).toBe(false)
  }, 20_000)
  it.each(['identity', 'published', 'draft-url'])('rechecks Linux draft %s before mutation', change => {
    const input = linuxFixture(); input.url = `https://github.com/wizlijun/note.md/releases/tag/${draftSlug}`
    const h = harness(input, false, change), result = runInteractive(h, ['--linux-only'], `${tag} linux-only`)
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(false)
  }, 20_000)
})

function linuxAmd64Fixture() {
  const input = linuxFixture()
  input.assets = input.assets.filter(a => !a.name.endsWith('_arm64.deb'))
  input.contents['SHA256SUMS-linux.txt'] = `${sha('amd64-deb')}  note.md_${version}_amd64.deb\n`
  input.assets.find(a => a.name === 'SHA256SUMS-linux.txt')!.content = input.contents['SHA256SUMS-linux.txt']
  return input
}

describe('explicit Linux-amd64-only publication', () => {
  it('accepts exactly amd64 and its checksum only in the explicit single-architecture mode', () => {
    expect(() => validateRelease({ ...linuxAmd64Fixture(), linuxAmd64Only: true })).not.toThrow()
    expect(() => validateRelease({ ...linuxAmd64Fixture(), linuxOnly: true })).toThrow()
    expect(() => validateRelease({ ...linuxFixture(), linuxAmd64Only: true })).toThrow()
  })
  it.each([{ linuxOnly: true }, { macArm64Only: true }, { without: 'linux' }, { without: 'windows' }])('rejects incompatible mode %j', other => {
    expect(() => validateRelease({ ...linuxAmd64Fixture(), linuxAmd64Only: true, ...other })).toThrow()
  })
  it.each([false, true])('publishes downloaded amd64 bytes with latest=false, prerelease=%s', prerelease => {
    const h = harness(linuxAmd64Fixture(), prerelease)
    const result = runInteractive(h, ['--linux-amd64-only'], `${tag} linux-amd64-only`)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(calls(h.log).filter(c => c.includes('edit'))).toEqual([['-R', 'wizlijun/note.md', 'release', 'edit', tag, '--draft=false', '--latest=false']])
    expect(calls(h.log).filter(c => c.includes('download')).map(c => c[c.indexOf('--pattern') + 1])).toEqual(['SHA256SUMS-linux.txt', `note.md_${version}_amd64.deb`])
  }, 20_000)
  it('accepts only its matching draft slug', () => {
    const input = linuxAmd64Fixture(); input.url = `https://github.com/wizlijun/note.md/releases/tag/${draftSlug}`
    input.assets.forEach(asset => { asset.url = draftBase + asset.name })
    const h = harness(input), result = runInteractive(h, ['--linux-amd64-only'], `${tag} linux-amd64-only`)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(calls(h.log).filter(c => c.includes('view'))).toHaveLength(2)
  }, 20_000)
  it.each(['bytes', 'checksum', 'missing-deb', 'missing-checksum', 'old-url', 'other-draft', 'latest', 'arm64', 'extra-checksum', 'arm64-checksum', 'duplicate-checksum'])('rejects invalid single-architecture evidence: %s', drift => {
    const input = linuxAmd64Fixture(), name = `note.md_${version}_amd64.deb`
    if (drift === 'bytes') input.contents[name] = 'different-downloaded-bytes'
    if (drift === 'checksum') input.contents['SHA256SUMS-linux.txt'] = input.contents['SHA256SUMS-linux.txt'].replace(sha('amd64-deb'), '0'.repeat(64))
    if (drift === 'missing-deb') input.assets = input.assets.filter(a => a.name !== name)
    if (drift === 'missing-checksum') input.assets = input.assets.filter(a => a.name !== 'SHA256SUMS-linux.txt')
    if (drift === 'old-url') input.assets[0].url = input.assets[0].url.replace(tag, 'v6.1014.1')
    if (drift === 'other-draft') input.assets[0].url = draftBase + input.assets[0].name
    if (drift === 'latest') input.assets.push(fixture().assets.find(a => a.name === 'latest.json')!)
    if (drift === 'arm64') input.assets.push(fixture().assets.find(a => a.name.endsWith('_arm64.deb'))!)
    if (drift === 'extra-checksum') input.contents['SHA256SUMS-linux.txt'] += `${sha('arm64-deb')}  note.md_${version}_arm64.deb\n`
    if (drift === 'arm64-checksum') input.contents['SHA256SUMS-linux.txt'] = `${sha('arm64-deb')}  note.md_${version}_arm64.deb\n`
    if (drift === 'duplicate-checksum') input.contents['SHA256SUMS-linux.txt'] += input.contents['SHA256SUMS-linux.txt']
    const h = harness(input), result = runInteractive(h, ['--linux-amd64-only'], `${tag} linux-amd64-only`)
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('upload'))).toBe(false)
  }, 20_000)
  it.each(['identity', 'published', 'draft-url'])('rechecks single-architecture draft %s immediately before publication', change => {
    const input = linuxAmd64Fixture(); input.url = `https://github.com/wizlijun/note.md/releases/tag/${draftSlug}`
    const h = harness(input, false, change), result = runInteractive(h, ['--linux-amd64-only'], `${tag} linux-amd64-only`)
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(false)
  }, 20_000)
  it.each(['yes', `${tag} linux-only`, 'v6.1014.1 linux-amd64-only'])('rejects incorrect confirmation %s', answer => {
    const h = harness(linuxAmd64Fixture()), result = runInteractive(h, ['--linux-amd64-only'], answer)
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit'))).toBe(false)
  }, 20_000)
  it.each([['--linux-amd64-only'], ['--linux-amd64-only', '--linux-only'], ['--linux-amd64-only', '--mac-arm64-only'], ['--linux-amd64-only', '--without', 'windows']])('rejects noninteractive or combined arguments %j', (...args) => {
    const h = harness(linuxAmd64Fixture()), result = h.run([tag, ...args])
    expect(result.status).not.toBe(0)
    expect(calls(h.log)).toEqual([])
  })
})


describe('approved Faitc5 companion boundary', () => {
  it('requires both companion assets for all Mac release modes', () => {
    for (const source of [fixture(), armFixture()]) {
      for (const name of ['faitc5-companion.json', companionFilename]) {
        const input = { ...source, assets: source.assets.filter(a => a.name !== name), macArm64Only: source.latest.platforms['darwin-x86_64'] === undefined }
        expect(() => validateRelease(input)).toThrow()
      }
    }
  })
  it('requires local approval rather than accepting any self-consistent uploaded JSON', () => {
    expect(() => validateRelease({ ...fixture(), approvedCompanion: undefined })).toThrow()
    const input = fixture(), changed = { ...input.approvedCompanion, sourceCommit: 'b'.repeat(40) }
    input.assets.find(a => a.name === 'faitc5-companion.json')!.content = JSON.stringify(changed)
    expect(() => validateRelease(input)).toThrow()
  })
  it('allows a newly approved version without a code version allowlist', () => {
    const input = armFixture(), newer = 'Faitc5-for-Sumi-0.5.0.14-arm64.pkg'
    input.approvedCompanion = { ...input.approvedCompanion, version: '0.5.0.14', filename: newer }
    input.assets.find(a => a.name === 'faitc5-companion.json')!.content = JSON.stringify(input.approvedCompanion)
    const pkg = input.assets.find(a => a.name === companionFilename)!; pkg.name = newer; pkg.url = base + newer
    expect(() => validateRelease({ ...input, macArm64Only: true })).not.toThrow()
  })
  it.each(['hash', 'bytes', 'old-tag', 'other-repo', 'other-pkg', 'updater'])('rejects invalid companion evidence: %s', kind => {
    const input = fixture(), pkg = input.assets.find(a => a.name === companionFilename)!
    if (kind === 'hash') pkg.sha256 = '0'.repeat(64)
    if (kind === 'bytes') pkg.bytes += 1
    if (kind === 'old-tag') pkg.url = pkg.url.replace(tag, 'v6.1014.1')
    if (kind === 'other-repo') pkg.url = pkg.url.replace('/note.md/', '/other/')
    if (kind === 'other-pkg') input.assets.push({ ...pkg, name: 'arbitrary.pkg', url: base + 'arbitrary.pkg' })
    if (kind === 'updater') input.latest.platforms['darwin-aarch64'].url = pkg.url
    expect(() => validateRelease(input)).toThrow()
  })
  it.each([
    { schema: 2 }, { product: 'Other' }, { platform: 'darwin-x86_64' }, { version: '../0.5.0.13' },
    { filename: '../Faitc5-for-Sumi-0.5.0.13-arm64.pkg' }, { filename: 'Faitc5-for-Sumi-0.5.0.14-arm64.pkg' },
    { sha256: 'x'.repeat(64) }, { bytes: 0 }, { bytes: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 },
    { sourceCommit: 'short' }, { appNotarized: false }, { packageSigned: 'false' }, { unknown: true },
  ])('rejects malformed approval %j', change => {
    expect(() => validateCompanionMetadata({ ...approvedCompanion(), ...change })).toThrow()
  })
  it('accepts accurate unsigned-package metadata without calling it a package signature', () => {
    expect(validateCompanionMetadata(approvedCompanion()).packageSigned).toBe(false)
  })
  it.each(['bytes', 'approved-json', 'malformed-json', 'missing-json', 'missing-pkg'])('CLI never publishes invalid downloaded companion: %s', drift => {
    const input = fixture()
    if (drift === 'bytes') input.contents[companionFilename] += 'tampered'
    if (drift === 'approved-json') input.contents['faitc5-companion.json'] = JSON.stringify({ ...input.approvedCompanion, sourceCommit: 'b'.repeat(40) })
    if (drift === 'malformed-json') input.contents['faitc5-companion.json'] = '{bad'
    if (drift === 'missing-json') input.assets = input.assets.filter(a => a.name !== 'faitc5-companion.json')
    if (drift === 'missing-pkg') input.assets = input.assets.filter(a => a.name !== companionFilename)
    const h = harness(input), result = h.run()
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('edit') || c.includes('upload'))).toBe(false)
  })
  it('Linux-only assets remain independent of the Mac approval file', () => {
    const h = harness(linuxFixture()); rmSync(join(h.root, 'scripts/release-companions/faitc5.json'))
    const result = runInteractive(h, ['--linux-only'], `${tag} linux-only`)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(calls(h.log).some(c => c.includes('faitc5-companion.json'))).toBe(false)
  }, 20_000)
})
