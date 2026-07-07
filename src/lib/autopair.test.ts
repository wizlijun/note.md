import { describe, it, expect } from 'vitest'
import { autoPairInsert } from './autopair'

describe('autoPairInsert', () => {
  it('closes [[ into [[]] on the second bracket', () => {
    // buffer "[" with cursor after it, typing the second "["
    expect(autoPairInsert('[', 1, '[')).toEqual({ insert: '[]]', caret: 1 })
  })

  it('does not close on the first bracket', () => {
    expect(autoPairInsert('', 0, '[')).toBe(null)
  })

  it('closes doubled emphasis markers (typed char + closer)', () => {
    // Buffer already holds the first marker char; inserting the typed char plus
    // the two-char closer yields e.g. `**|**`.
    expect(autoPairInsert('*', 1, '*')).toEqual({ insert: '***', caret: 1 })
    expect(autoPairInsert('_', 1, '_')).toEqual({ insert: '___', caret: 1 })
    expect(autoPairInsert('^', 1, '^')).toEqual({ insert: '^^^', caret: 1 })
    expect(autoPairInsert('~', 1, '~')).toEqual({ insert: '~~~', caret: 1 })
    expect(autoPairInsert('=', 1, '=')).toEqual({ insert: '===', caret: 1 })
  })

  it('avoids triples (no re-close on the third identical char)', () => {
    expect(autoPairInsert('**', 2, '*')).toBe(null)
    expect(autoPairInsert('[[', 2, '[')).toBe(null)
  })

  it('respects the surrounding text when deciding the previous char', () => {
    expect(autoPairInsert('foo*', 4, '*')).toEqual({ insert: '***', caret: 1 })
    expect(autoPairInsert('foo', 3, '*')).toBe(null)
  })

  it('closes a single backtick but not inside a run', () => {
    expect(autoPairInsert('', 0, '`')).toEqual({ insert: '``', caret: 1 })
    expect(autoPairInsert('`', 1, '`')).toBe(null)
  })

  it('ignores non-marker characters', () => {
    expect(autoPairInsert('a', 1, 'b')).toBe(null)
  })
})
