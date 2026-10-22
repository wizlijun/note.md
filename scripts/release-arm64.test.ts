import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const source = readFileSync(resolve('scripts/release.sh'), 'utf8')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
const argsSection = source.slice(source.indexOf('VERSION=""'), source.indexOf('# Date-based auto-derivation'))

describe('macOS build architecture selection', () => {
  it.each([false, true])('builds only requested architectures (arm64-only=%s)', armOnly => {
    const builds = source.slice(source.indexOf('\nbuild_arch aarch64-apple-darwin'), source.indexOf('# ---------- commit, tag, push'))
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${argsSection}\nbuild_arch() { echo "$1 $2"; }\n${builds}`, 'release-test', '6.1022.2', ...(armOnly ? ['--arm64-only'] : [])], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual(armOnly
      ? ['aarch64-apple-darwin aarch64']
      : ['aarch64-apple-darwin aarch64', 'x86_64-apple-darwin x86_64'])
  })

  it.each([false, true])('creates a draft with only built architectures (arm64-only=%s)', armOnly => {
    const root = mkdtempSync(join(tmpdir(), 'notemd-arm64-release-')); roots.push(root)
    const log = join(root, 'calls.jsonl')
    writeFileSync(join(root, 'gh'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');console.log('https://example.invalid');\n`, { mode: 0o755 })
    const section = source.slice(source.indexOf('EXTRA=()')).replace('LATEST_JSON_STAGED="/tmp/latest.json"', `LATEST_JSON_STAGED="${root}/latest.json"`)
    // In ARM-only mode Intel signature must never be read, including under nounset.
    const prefix = `set -euo pipefail\nARM64_ONLY=${Number(armOnly)}; PRERELEASE=0; GH_REPO=wizlijun/note.md; TAG=v6.1022.2; VERSION=6.1022.2; NOTES=fixture; STAGED_ASSETS=(fixture.dmg); SIG_CONTENT_AARCH64=signed-arm\n${armOnly ? '' : 'SIG_CONTENT_X86_64=signed-intel\n'}`
    const result = spawnSync('bash', ['-c', prefix + section], { encoding: 'utf8', env: { ...process.env, PATH: root + ':' + process.env.PATH } })
    expect(result.status, result.stderr).toBe(0)
    const manifest = JSON.parse(readFileSync(join(root, 'latest.json'), 'utf8'))
    expect(manifest.version).toBe('6.1022.2')
    expect(Object.keys(manifest.platforms)).toEqual(armOnly ? ['darwin-aarch64'] : ['darwin-aarch64', 'darwin-x86_64'])
    expect(manifest.platforms['darwin-aarch64']).toEqual({ signature: 'signed-arm', url: 'https://github.com/wizlijun/note.md/releases/download/v6.1022.2/note.md-aarch64.app.tar.gz' })
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls.find(args => args.includes('create'))).toContain('--draft')
    expect(calls.some(args => args.includes('edit'))).toBe(false)
    if (armOnly) expect(result.stdout).toContain('--mac-arm64-only')
  })

  it.each([false, true])('advertises only the built installers (arm64-only=%s)', armOnly => {
    const section = source.slice(source.indexOf('INSTALLERS='), source.indexOf('# Release 正文'))
    const result = spawnSync('bash', ['-c', `set -euo pipefail\nARM64_ONLY=${Number(armOnly)}; VERSION=6.1022.2; APPLE_TEAM_ID=fixture\n${section}\nprintf '%s' "$PREAMBLE"`], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('note.md-6.1022.2-aarch64.dmg')
    expect(result.stdout.includes('note.md-6.1022.2-x86_64.dmg')).toBe(!armOnly)
  })
})
