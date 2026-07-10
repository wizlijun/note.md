// src/lib/outline/rename-pair.test.ts
import { describe, it, expect } from 'vitest'
import { planRename } from './rename-pair'

describe('planRename', () => {
  it('renaming xxx.md pairs its companion (new suffix)', () => {
    const plan = planRename('/d/a.md', 'b.md', ['a.md', 'a.note.md', 'z.md'])
    expect(plan).toEqual({
      ops: [
        { from: '/d/a.md', to: '/d/b.md' },
        { from: '/d/a.note.md', to: '/d/b.note.md' },
      ],
    })
  })
  it('legacy .notes.md companion pairs too, keeps legacy suffix', () => {
    const plan = planRename('/d/a.md', 'b.md', ['a.md', 'a.notes.md'])
    expect(plan).toEqual({
      ops: [
        { from: '/d/a.md', to: '/d/b.md' },
        { from: '/d/a.notes.md', to: '/d/b.notes.md' },
      ],
    })
  })
  it('no companion → single op', () => {
    expect(planRename('/d/a.md', 'b.md', ['a.md'])).toEqual({
      ops: [{ from: '/d/a.md', to: '/d/b.md' }],
    })
  })
  it('renaming a .note.md renames only itself (no reverse pairing)', () => {
    expect(planRename('/d/a.note.md', 'c.note.md', ['a.md', 'a.note.md'])).toEqual({
      ops: [{ from: '/d/a.note.md', to: '/d/c.note.md' }],
    })
  })
  it('sanitizes the new name (illegal chars → -)', () => {
    const plan = planRename('/d/a.md', 'x/y.md', ['a.md'])
    expect(plan!.ops[0].to).toBe('/d/x-y.md')
  })
  it('conflict: target name already exists in dir → null', () => {
    expect(planRename('/d/a.md', 'z.md', ['a.md', 'z.md'])).toBeNull()
    // 伴生目标冲突同样中止
    expect(planRename('/d/a.md', 'w.md', ['a.md', 'a.note.md', 'w.note.md'])).toBeNull()
  })
  it('no-op: same name → null', () => {
    expect(planRename('/d/a.md', 'a.md', ['a.md'])).toBeNull()
  })
  it('case-insensitive conflict detection, but case-only rename of itself allowed', () => {
    expect(planRename('/d/a.md', 'Z.md', ['a.md', 'z.md'])).toBeNull()
    const plan = planRename('/d/a.md', 'A.md', ['a.md'])
    expect(plan).toEqual({ ops: [{ from: '/d/a.md', to: '/d/A.md' }] })
  })
  it('rejects extension change on a paired main doc (would orphan companion)', () => {
    expect(planRename('/d/a.md', 'b', ['a.md', 'a.note.md'])).toBeNull()
    expect(planRename('/d/a.md', 'b.txt', ['a.md', 'a.notes.md'])).toBeNull()
    // 无伴生时改扩展名允许
    expect(planRename('/d/a.md', 'b.txt', ['a.md'])).toEqual({
      ops: [{ from: '/d/a.md', to: '/d/b.txt' }],
    })
  })
})
