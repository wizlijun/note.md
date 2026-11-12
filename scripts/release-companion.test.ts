import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageCompanion } from './release-companion.mjs'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fcitx5-stage-test-')); roots.push(root)
  const bytes = Buffer.from('isolated package fixture')
  const approved = { schema: 1, product: 'Fcitx5 for Sumi', version: '0.5.0.13', platform: 'darwin-aarch64', filename: 'Fcitx5-for-Sumi-0.5.0.13-arm64.pkg', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, sourceCommit: '1'.repeat(40), appNotarized: true, packageSigned: false }
  const source = join(root, approved.filename), output = join(root, 'stage')
  writeFileSync(source, bytes)
  return { approved, source, output, bytes }
}

describe('approved modified Fcitx5 release staging', () => {
  it('copies exact bytes and approval, disclosing unsigned installer separately from notarized App', () => {
    const f = fixture(), result = stageCompanion(f)
    expect(readFileSync(result.packagePath)).toEqual(f.bytes)
    expect(JSON.parse(readFileSync(result.metadataPath, 'utf8'))).toEqual(f.approved)
    expect(readFileSync(join(f.output, 'fcitx5-release-note.md'), 'utf8')).toContain('installer package itself is unsigned')
  })
  it('rejects a same-name package with changed bytes', () => {
    const f = fixture(); writeFileSync(f.source, Buffer.alloc(f.bytes.length))
    expect(() => stageCompanion(f)).toThrow('differs from approved build')
  })
  it('rejects a renamed package even when its contents match', () => {
    const f = fixture(); f.source = join(f.output, '..', 'other.pkg'); writeFileSync(f.source, f.bytes)
    expect(() => stageCompanion(f)).toThrow('filename differs')
  })
  it('does not overwrite already staged artifacts', () => {
    const f = fixture(); stageCompanion(f)
    expect(() => stageCompanion(f)).toThrow('already exists')
  })
})
