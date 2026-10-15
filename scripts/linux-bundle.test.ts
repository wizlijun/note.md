import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(__dirname, '..')
const script = join(root, 'scripts/docker/linux-build.sh')

describe('Linux source isolation', () => {
  it('copies sibling core dist but excludes host artifacts, stores and secrets at every depth', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'notemd-linux-copy-'))
    try {
      const input = join(fixture, 'input')
      const output = join(fixture, 'output')
      for (const name of [
        'package.json', 'dist/index.js', 'src/entry.ts',
        'node_modules/host/index.js', 'src-tauri/target/debug/notemd', '.git/config',
        '.pnpm-store/store', 'nested/.pnpm-store/store', 'nested/.env.production',
        '.env', '.env.local', '.wrangler/state', '.superpowers/private',
      ]) {
        mkdirSync(join(input, name, '..'), { recursive: true })
        writeFileSync(join(input, name), name)
      }
      const result = spawnSync('bash', ['-c', 'source "$1"; copy_source "$2" "$3"', '_', script, input, output], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      for (const name of ['package.json', 'dist/index.js', 'src/entry.ts']) {
        expect(readFileSync(join(output, name), 'utf8')).toBe(name)
      }
      for (const name of ['node_modules', 'src-tauri/target', '.git', '.pnpm-store', 'nested/.pnpm-store', 'nested/.env.production', '.env', '.env.local', '.wrangler', '.superpowers']) {
        expect(existsSync(join(output, name)), name).toBe(false)
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('rejects unsupported targets before accessing build inputs', () => {
    const result = spawnSync('bash', [script, 'aarch64-apple-darwin'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unsupported Linux target')
  })
})


describe('Linux Debian bundle', () => {
  it('accepts the actual merged main/Linux config through the installed Tauri schema', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'notemd-linux-schema-'))
    try {
      const marker = join(fixture, 'runner-called')
      const runner = join(fixture, 'runner')
      writeFileSync(runner, '#!/bin/sh\nprintf "%s\\n" "$@" > "$NOTEMD_RUNNER_MARKER"\nexit 77\n', { mode: 0o755 })
      const toolchain = process.env.RUSTUP_TOOLCHAIN ?? spawnSync('rustup', ['show', 'active-toolchain'], { cwd: root, encoding: 'utf8' }).stdout.trim().split(/\s+/)[0]
      const result = spawnSync(process.execPath, [
        join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build',
        '--config', join(root, 'src-tauri/tauri.linux.conf.json'),
        '--config', JSON.stringify({ build: { beforeBuildCommand: '' } }),
        '--runner', runner, '--no-bundle',
      ], { cwd: root, encoding: 'utf8', env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain, NOTEMD_RUNNER_MARKER: marker } })
      // The runner stops before compilation. Reaching it proves Tauri accepted
      // the merged config using its installed schema, without a frontend build.
      expect(existsSync(marker), result.stdout + result.stderr).toBe(true)
      expect(readFileSync(marker, 'utf8').split('\n')).toContain('build')
      expect(result.status).not.toBe(0)
      rmSync(marker)
      const invalid = spawnSync(process.execPath, [
        join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build',
        '--config', join(root, 'src-tauri/tauri.linux.conf.json'),
        '--config', JSON.stringify({ bundle: { linux: { deb: { desktopTemplate: 42 } } } }),
        '--runner', runner, '--no-bundle',
      ], { cwd: root, encoding: 'utf8', env: { ...process.env, RUSTUP_TOOLCHAIN: toolchain, NOTEMD_RUNNER_MARKER: marker } })
      expect(invalid.status).not.toBe(0)
      expect(existsSync(marker)).toBe(false)
      expect(invalid.stderr).toContain('desktopTemplate')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }, 30_000)

  it('replaces the macOS arrays while preserving host resources and complete MIME associations', () => {
    const base = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
    const linux = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.linux.conf.json'), 'utf8'))
    const merged = { ...base, app: { ...base.app, ...linux.app }, bundle: { ...base.bundle, ...linux.bundle } }
    expect(merged.bundle.targets).toEqual(['deb'])
    expect(merged.bundle.createUpdaterArtifacts).toBe(false)
    expect(merged.bundle.resources).toEqual(['resources/themes/**/*'])
    expect(merged.bundle.fileAssociations.map((a: { mimeType: string }) => a.mimeType)).toEqual(['text/markdown', 'text/plain', 'application/json'])
    expect(merged.bundle.fileAssociations.flatMap((a: { ext: string[] }) => a.ext)).toEqual(['md', 'markdown', 'mdown', 'mkd', 'txt', 'text', 'canvas'])
    expect(merged.bundle.linux.deb.depends).toEqual(['libwebkit2gtk-4.1-0', 'libgtk-3-0', 'libayatana-appindicator3-1', 'git', 'xdg-utils'])
    expect(merged.bundle.license).toBe('Apache-2.0')
    const license = readFileSync(join(root, 'src-tauri', merged.bundle.licenseFile), 'utf8')
    expect(license).toContain('Version 2.0, January 2004')
    expect(license).toContain('END OF TERMS AND CONDITIONS')
    expect(readFileSync(join(root, 'src-tauri', merged.bundle.linux.deb.files['/usr/share/doc/note.md/copyright']), 'utf8')).toBe(license)
    for (const icon of merged.bundle.icon) {
      expect(readFileSync(join(root, 'src-tauri', icon)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    }
    expect(merged.app.enableGTKAppId).toBe(true)
  })
})
