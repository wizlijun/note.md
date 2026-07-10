// src/lib/outline/migrate.test.ts
import { describe, it, expect } from 'vitest'
import { legacyCompanionPathFor, migratedPathFor } from './migrate'

describe('legacyCompanionPathFor', () => {
  it('maps main file to sibling legacy .notes.md', () => {
    expect(legacyCompanionPathFor('/d/foo.md')).toBe('/d/foo.notes.md')
  })
  it('null for companion files and non-md', () => {
    expect(legacyCompanionPathFor('/d/foo.note.md')).toBeNull()
    expect(legacyCompanionPathFor('/d/x.png')).toBeNull()
  })
})

describe('migratedPathFor', () => {
  it('rewrites legacy suffix to .note.md (case-insensitive)', () => {
    expect(migratedPathFor('/d/foo.notes.md')).toBe('/d/foo.note.md')
    expect(migratedPathFor('/d/FOO.NOTES.MD')).toBe('/d/FOO.note.md')
  })
  it('null for non-legacy paths', () => {
    expect(migratedPathFor('/d/foo.note.md')).toBeNull()
    expect(migratedPathFor('/d/foo.md')).toBeNull()
  })
})
