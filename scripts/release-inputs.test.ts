import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { checkClean, checkFrozenShare } from './release-inputs.mjs'
import { controlledEnvDir } from './controlled-env.mjs'

const roots: string[] = []
function directory() { const path = mkdtempSync(join(tmpdir(), 'notemd-release-')); roots.push(path); return path }
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
describe('release input boundaries', () => {
  it('keeps default dotenv behavior and rejects any content in explicit envDir', () => {
    const path = directory()
    expect(controlledEnvDir(path)).toBe(realpathSync(path))
    writeFileSync(join(path, '.env'), 'secret=never-load')
    expect(() => controlledEnvDir(path)).toThrow('must be empty')
    expect(() => controlledEnvDir('')).toThrow()
  })
  it('uses real git status and permits only exact unchanged untracked files and existing cache', () => {
    const path = directory(), evidence = directory()
    execFileSync('git', ['init', '-q', path])
    writeFileSync(join(path, 'tracked'), 'original')
    execFileSync('git', ['add', 'tracked'], { cwd: path })
    execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'fixture'], { cwd: path })
    writeFileSync(join(path, 'retained.md'), 'keep')
    mkdirSync(join(path, '.pnpm-store'))
    writeFileSync(join(path, '.pnpm-store', 'cache'), 'keep cache')
    const list = join(evidence, 'allow.json')
    writeFileSync(list, JSON.stringify([{ path: 'retained.md', sha256: hash('keep') }, { path: '.pnpm-store', directory: true }]))
    expect(() => checkClean(path)).toThrow('dirty')
    expect(checkClean(path, list).preserved).toEqual(['retained.md', '.pnpm-store/'])
    writeFileSync(join(path, 'unknown'), 'extra')
    expect(() => checkClean(path, list)).toThrow('unknown')
    rmSync(join(path, 'unknown'))
    writeFileSync(join(path, 'tracked'), 'changed')
    expect(() => checkClean(path, list)).toThrow('tracked')
    execFileSync('git', ['add', 'tracked'], { cwd: path })
    expect(() => checkClean(path, list)).toThrow('tracked')
    writeFileSync(join(path, 'retained.md'), 'changed')
    expect(() => checkClean(path, list)).toThrow('Preserved file changed')
    writeFileSync(list, JSON.stringify([{path: '.pnpm-store', directory: true}, {path: '.pnpm-store', directory: true}]))
    expect(() => checkClean(path, list)).toThrow('Invalid preservation path')
    writeFileSync(list, JSON.stringify([{ path: '../escape', sha256: hash('x') }]))
    expect(() => checkClean(path, list)).toThrow('Invalid preservation path')
  })
  it('rejects changed manifest text and changed resource bytes', () => {
    const path = directory(), evidence = directory()
    mkdirSync(join(path, 'assets'))
    const assets = Object.fromEntries(['js', 'css', 'mermaid'].map(kind => {
      const bytes = `resource-${kind}`, sha256 = hash(bytes)
      const name = `share-editor${kind === 'mermaid' ? '-mermaid' : ''}.${sha256}.${kind === 'css' ? 'css' : 'js'}`
      writeFileSync(join(path, 'assets', name), bytes)
      return [kind, { name, sha256, sri: 'sha384-' + createHash('sha384').update(bytes).digest('base64') }]
    }))
    const text = JSON.stringify({ apiVersion: 1, ...assets }), candidate = join(evidence, 'manifest.json')
    writeFileSync(candidate, text)
    writeFileSync(join(path, 'share-editor-manifest.json'), text)
    expect(checkFrozenShare(candidate, path).resources).toHaveLength(3)
    writeFileSync(join(path, 'share-editor-manifest.json'), text + '\n')
    expect(() => checkFrozenShare(candidate, path)).toThrow('manifest changed')
    writeFileSync(join(path, 'share-editor-manifest.json'), text)
    writeFileSync(join(path, 'assets', assets.js.name), 'wrong bytes')
    expect(() => checkFrozenShare(candidate, path)).toThrow('js bytes changed')
  })
})
