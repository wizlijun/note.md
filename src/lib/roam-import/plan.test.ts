// src/lib/roam-import/plan.test.ts
import { describe, it, expect } from 'vitest'
import { assignFiles, planActions } from './plan'
import type { ImportManifest, RoamPage } from './types'

const dirs = { wikipage: 'wikipage', dailynote: 'dailynote' }

describe('assignFiles', () => {
  it('routes daily pages by uid and wiki pages by sanitized title', () => {
    const pages: RoamPage[] = [
      { title: 'July 11th, 2026', uid: '07-11-2026' },
      { title: 'a/b', uid: 'p1' },
    ]
    const r = assignFiles(pages, dirs)
    expect(r.files[0]).toMatchObject({ kind: 'daily', relPath: 'dailynote/2026/2026-07-11.note.md' })
    expect(r.files[1]).toMatchObject({ kind: 'wiki', relPath: 'wikipage/a-b.note.md', finalName: 'a-b' })
    expect(r.renames.get('a/b')).toBe('a-b')
  })

  it('dedupes case-insensitive collisions with " (2)" and records renames', () => {
    const pages: RoamPage[] = [
      { title: 'Test', uid: 'p1' },
      { title: 'test', uid: 'p2' },
    ]
    const r = assignFiles(pages, dirs)
    expect(r.files[0].relPath).toBe('wikipage/Test.note.md')
    expect(r.files[1].relPath).toBe('wikipage/test (2).note.md')
    expect(r.renames.get('test')).toBe('test (2)')
    expect(r.warnings).toHaveLength(1)
  })
})

describe('planActions', () => {
  const manifest: ImportManifest = {
    graphName: 'g', importedAt: 'x',
    pages: { p1: { file: 'wikipage/A.note.md', editTime: 100, contentHash: 'h1' } },
  }
  it('create when new, skip when edit-time unchanged', () => {
    const acts = planActions(
      [{ key: 'p2', relPath: 'wikipage/B.note.md', editTime: 5 },
       { key: 'p1', relPath: 'wikipage/A.note.md', editTime: 100 }],
      manifest, new Map([['wikipage/A.note.md', 'h1']]),
    )
    expect(acts).toEqual([
      { key: 'p2', relPath: 'wikipage/B.note.md', action: 'create' },
      { key: 'p1', relPath: 'wikipage/A.note.md', action: 'skip' },
    ])
  })
  it('overwrite when changed and local untouched; conflict when local modified', () => {
    const entries = [{ key: 'p1', relPath: 'wikipage/A.note.md', editTime: 200 }]
    expect(planActions(entries, manifest, new Map([['wikipage/A.note.md', 'h1']]))[0].action).toBe('overwrite')
    expect(planActions(entries, manifest, new Map([['wikipage/A.note.md', 'DIFFERENT']]))[0].action).toBe('conflict')
    expect(planActions(entries, manifest, new Map([['wikipage/A.note.md', null]]))[0].action).toBe('create')
  })
  it('no manifest → everything is create', () => {
    expect(planActions([{ key: 'k', relPath: 'f', editTime: 1 }], null, new Map())[0].action).toBe('create')
  })
})
