import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function dir() { const root = mkdtempSync(join(tmpdir(), 'notemd-linux-release-')); roots.push(root); return root }
function executable(path: string, text: string) { writeFileSync(path, text, { mode: 0o755 }) }
const version = '6.1015.1', tag = 'v6.1015.1'
function git(root: string, ...args: string[]) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim() }
function init(root: string) {
  git(root, 'init', '-q'); git(root, 'add', '.')
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
}
function linuxHarness(options: { draft?: boolean; packageVersion?: string; fail?: string; remoteMismatch?: boolean } = {}) {
  const root = dir(), repo = join(root, 'mdeditor'), core = join(root, 'moraya-core'), bin = join(root, 'bin'), log = join(root, 'calls')
  mkdirSync(join(repo, 'scripts/docker'), { recursive: true }); mkdirSync(join(repo, 'src-tauri'), { recursive: true })
  mkdirSync(join(core, 'dist'), { recursive: true }); mkdirSync(bin)
  for (const name of ['release-linux.sh', 'release-linux-verify.sh']) cpSync(resolve('scripts', name), join(repo, 'scripts', name))
  writeFileSync(join(repo, 'scripts/docker/linux-build.Dockerfile'), 'FROM scratch\n')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ version: options.packageVersion || version }))
  writeFileSync(join(repo, 'src-tauri/tauri.conf.json'), JSON.stringify({ version }))
  writeFileSync(join(repo, 'src-tauri/Cargo.toml'), `[package]\nname="fixture"\nversion = "${version}"\n`)
  writeFileSync(join(repo, '.env.private'), 'fixture-secret'); writeFileSync(join(repo, 'credentials.json'), 'fixture-secret')
  writeFileSync(join(core, 'dist/index.js'), 'tracked-core'); writeFileSync(join(core, '.env'), 'fixture-secret')
  init(repo); git(repo, 'tag', tag); init(core)
  const remoteCommit = options.remoteMismatch ? '0'.repeat(40) : git(repo, 'rev-parse', 'HEAD')
  executable(join(bin, 'gh'), `#!/usr/bin/env node
const fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['gh',...a])+'\\n');
if(a.includes('api')) console.log(${JSON.stringify(remoteCommit)});
else if(a.includes('view')) console.log(JSON.stringify({tagName:${JSON.stringify(tag)},isDraft:${options.draft !== false}}));
else if(!a.includes('upload'))process.exit(5);
`)
  executable(join(bin, 'docker'), `#!/usr/bin/env node
const fs=require('fs'),p=require('path'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(['docker',...a])+'\\n');
if(a[0]==='build'){const ctx=a.at(-1);if(fs.existsSync(p.join(ctx,'.env.private'))||fs.existsSync(p.join(ctx,'credentials.json')))process.exit(31);}
if(a.includes('/verify.sh')) {if(${JSON.stringify(options.fail)}==='verify')process.exit(23);}
else if(a[0]==='run') {if(${JSON.stringify(options.fail)}==='build')process.exit(22);let out;for(let i=0;i<a.length;i++)if(a[i]==='--mount'&&a[i+1].includes('dst=/output'))out=a[i+1].match(/src=([^,]+)/)[1];if(!out)process.exit(32);const arch=a[a.indexOf('--platform')+1].endsWith('amd64')?'amd64':'arm64';fs.writeFileSync(p.join(out,'note.md_${version}_'+arch+'.deb'),'fixture '+arch);}
`)
  return { root, repo, log, run: (args = [tag]) => spawnSync('bash', [join(repo, 'scripts/release-linux.sh'), ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH } }) }
}
function calls(log: string): string[][] { return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] }
describe('Linux release orchestration (fake remote/build boundary)', () => {
  it('builds immutable read-only sources with per-architecture caches and uploads only after both verifiers', () => {
    const h = linuxHarness(), result = h.run()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const all = calls(h.log), upload = all.findIndex(c => c.includes('upload'))
    const builds = all.filter(c => c[0] === 'docker' && c[1] === 'run' && !c.includes('/verify.sh'))
    expect(builds).toHaveLength(2)
    expect(builds.map(c => c[c.indexOf('--platform') + 1]).sort()).toEqual(['linux/amd64', 'linux/arm64'])
    for (const build of builds) {
      expect(build.filter(a => a.includes('dst=/input/'))).toHaveLength(2)
      expect(build.filter(a => a.includes('dst=/input/')).every(a => a.includes('readonly'))).toBe(true)
      const arch = build[build.indexOf('--platform') + 1].split('/')[1]
      expect(build.some(a => a.includes(`notemd-linux-${arch}-target`))).toBe(true)
      expect(build.some(a => a.includes(`notemd-linux-${arch}-pnpm`))).toBe(true)
      expect(build.some(a => a.includes(`notemd-linux-${arch}-node`))).toBe(true)
      const source = build.find(a => a.includes('dst=/input/mdeditor'))!.match(/src=([^,]+)/)![1]
      expect(existsSync(source)).toBe(false) // trap cleaned the temporary artifact worktree/input
    }
    expect(all.slice(0, upload).filter(c => c.includes('/verify.sh'))).toHaveLength(3) // two ELF/layout inspections + Arch amd64 runtime
    expect(all[upload].filter(a => /\.deb$|SHA256SUMS-linux\.txt$/.test(a))).toHaveLength(3)
    expect(git(h.repo, 'symbolic-ref', '--short', 'HEAD')).not.toBe('HEAD')
    expect(git(h.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
    expect(readFileSync(join(h.repo, 'package.json'), 'utf8')).toContain(version)
  }, 20_000)
  it.each([{ draft: false }, { packageVersion: '6.1014.1' }, { remoteMismatch: true }, { fail: 'build' }, { fail: 'verify' }])('never uploads on preflight/build/verification failure %j', options => {
    const h = linuxHarness(options), result = h.run()
    expect(result.status).not.toBe(0)
    expect(calls(h.log).some(c => c.includes('upload') || c.includes('edit'))).toBe(false)
    expect(git(h.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1)
  }, 20_000)
  it('rejects invalid tag syntax before any remote or build operation', () => {
    const h = linuxHarness(), result = h.run(['--yes'])
    expect(result.status).not.toBe(0)
    expect(calls(h.log)).toEqual([])
  })
})

describe('package verification decisions (controlled dpkg/readelf command outputs)', () => {
  function verify(changes: Partial<Record<string, string>> = {}, missing = '', mode = '--inspect') {
    const root = dir(), bin = join(root, 'bin'); mkdirSync(bin)
    const values = { Package: 'note-md', Version: version, Architecture: 'amd64', Machine: 'Advanced Micro Devices X86-64', GLIBC: '2.36', Needed: 'libc.so.6', Interpreter: '/lib64/ld-linux-x86-64.so.2', Ldd: 'libc.so.6 => /usr/lib/libc.so.6', Cli: 'notemd 6.1015.1 (plugin API v1)', ...changes }
    executable(join(bin, 'dpkg-deb'), `#!/usr/bin/env node
const fs=require('fs'),p=require('path'),a=process.argv.slice(2),v=${JSON.stringify(values)};
if(a[0]==='-f'){console.log(v[a[2]]);}
else if(a[0]==='-x'){const r=a[2],files={'usr/bin/notemd':'#!/bin/sh\\nprintf \\'%s\\\\n\\' '+JSON.stringify(v.Cli)+'\\n','usr/share/applications/note.md.desktop':'[Desktop Entry]\\nExec=notemd --gui %U\\nIcon=notemd\\nMimeType=text/markdown;text/plain;application/json;x-scheme-handler/notemd;\\n','usr/share/icons/hicolor/32x32/apps/notemd.png':'png','usr/lib/note.md/resources/themes/default.css':'theme','usr/share/doc/note.md/copyright':'Apache License\\nVersion 2.0, January 2004\\nEND OF TERMS AND CONDITIONS'};for(const [n,t]of Object.entries(files)){if(n.includes(${JSON.stringify(missing || 'NO-OMISSION')}))continue;fs.mkdirSync(p.dirname(p.join(r,n)),{recursive:true});fs.writeFileSync(p.join(r,n),t,{mode:0o755});}}
else process.exit(4);
`)
    executable(join(bin, 'readelf'), `#!/usr/bin/env node
const a=process.argv.slice(2),v=${JSON.stringify(values)};if(a[0]==='-h')console.log('  Class: ELF64\\n  Type: DYN (Position-Independent Executable file)\\n  Machine: '+v.Machine);else if(a[0]==='-l')console.log('[Requesting program interpreter: '+v.Interpreter+']');else if(a[0]==='--version-info')console.log('Name: GLIBC_'+v.GLIBC);else if(a[0]==='-d')console.log(' 0x0000000000000001 (NEEDED) Shared library: ['+v.Needed+']');else process.exit(4);
`)
    executable(join(bin, 'pacman'), '#!/bin/sh\n[ "$1" = -Syu ] || exit 5\n')
    executable(join(bin, 'ldd'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(values.Ldd)});\n`)
    const deb = join(root, `note.md_${version}_amd64.deb`); writeFileSync(deb, 'fixture')
    return spawnSync('bash', [resolve('scripts/release-linux-verify.sh'), mode, deb, version, 'amd64'], { encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH } })
  }
  it('accepts matching package/ELF/layout inputs at GLIBC 2.36', () => {
    const result = verify(); expect(result.status, result.stderr).toBe(0)
  })
  it.each([{ Package: 'wrong' }, { Version: '6.1014.1' }, { Architecture: 'arm64' }, { Machine: 'AArch64' }, { GLIBC: '2.37' }, { Needed: 'libssl.so.3' }, { Interpreter: '/unknown/ld.so' }])('rejects metadata/ABI incompatibility %j', changes => {
    const result = verify(changes); expect(result.status, result.stderr).not.toBe(0)
  })
  it.each(['note.md.desktop', 'icons', 'themes', 'copyright'])('rejects missing package layout %s', missing => {
    expect(verify({}, missing).status).not.toBe(0)
  })
  it('accepts resolved Arch symbols and exact CLI version', () => {
    const result = verify({}, '', '--arch-runtime'); expect(result.status, result.stderr).toBe(0)
  })
  it.each([{ Ldd: 'libfoo.so => not found' }, { Ldd: 'undefined symbol: foo' }, { Cli: 'notemd 6.1014.1 (plugin API v1)' }])('rejects Arch runtime incompatibility %j', changes => {
    expect(verify(changes, '', '--arch-runtime').status).not.toBe(0)
  })
})

describe('macOS draft creation command', () => {
  it.each([0, 1])('always creates a draft while retaining prerelease=%s', prerelease => {
    const root = dir(), log = join(root, 'calls'), gh = join(root, 'gh')
    executable(gh, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');console.log('https://example.invalid');\n`)
    const source = readFileSync(resolve('scripts/release.sh'), 'utf8')
    // Execute the actual final creation section without running signing/builds.
    const section = source.slice(source.indexOf('EXTRA=()'))
    const prefix = `set -euo pipefail\nDRAFT=0; PRERELEASE=${prerelease}; GH_REPO=wizlijun/note.md; TAG=${tag}; VERSION=${version}; NOTES=fixture; STAGED_ASSETS=(fixture.dmg); SIG_CONTENT_AARCH64=arm; SIG_CONTENT_X86_64=intel\n`
    const result = spawnSync('bash', ['-c', prefix + section.replace('LATEST_JSON_STAGED="/tmp/latest.json"', `LATEST_JSON_STAGED="${root}/latest.json"`)], { encoding: 'utf8', env: { ...process.env, PATH: root + ':' + process.env.PATH } })
    expect(result.status, result.stderr).toBe(0)
    const args = calls(log).find(c => c.includes('create'))!
    expect(args).toContain('--draft')
    expect(args.includes('--prerelease')).toBe(Boolean(prerelease))
  })
})
