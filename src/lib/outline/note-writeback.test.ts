import { describe, it, expect } from 'vitest'
import { replaceNoteInMd } from './note-writeback'

describe('replaceNoteInMd — wrapped annotations', () => {
  it('replaces the note of a wrapped annotation located by its original text', () => {
    const md = '前文 {==原文==}{>>旧批注<<} 后文\n'
    expect(replaceNoteInMd(md, { original: '原文', oldNote: '旧批注', newNote: '新批注' }))
      .toBe('前文 {==原文==}{>>新批注<<} 后文\n')
  })

  it('uses anchorLine to disambiguate identical annotations', () => {
    const md = '{==词==}{>>n<<}\n\n{==词==}{>>n<<}\n'
    const out = replaceNoteInMd(md, { original: '词', oldNote: 'n', newNote: '改', anchorLine: 3 })
    expect(out).toBe('{==词==}{>>n<<}\n\n{==词==}{>>改<<}\n')
  })

  it('falls back to the first occurrence when anchorLine misses', () => {
    const md = '{==词==}{>>n<<}\n'
    const out = replaceNoteInMd(md, { original: '词', oldNote: 'n', newNote: '改', anchorLine: 99 })
    expect(out).toBe('{==词==}{>>改<<}\n')
  })

  it('returns null when nothing matches', () => {
    expect(replaceNoteInMd('无批注\n', { original: 'x', oldNote: 'y', newNote: 'z' })).toBeNull()
  })

  it('sanitizes the new note (newlines and <<})', () => {
    const md = '{==词==}{>>n<<}\n'
    const out = replaceNoteInMd(md, { original: '词', oldNote: 'n', newNote: 'a\nb <<} c' })
    expect(out).toBe('{==词==}{>>a b < <} c<<}\n')
  })
})

describe('replaceNoteInMd — point annotations', () => {
  it('replaces a point annotation located by its old note text', () => {
    const md = '句子结尾{>>旧备注<<}。\n'
    expect(replaceNoteInMd(md, { original: null, oldNote: '旧备注', newNote: '新备注' }))
      .toBe('句子结尾{>>新备注<<}。\n')
  })

  it('does not touch wrapped annotations when replacing a point one', () => {
    const md = '{==词==}{>>same<<} 和点批注{>>same<<}。\n'
    const out = replaceNoteInMd(md, { original: null, oldNote: 'same', newNote: '改', anchorLine: 1 })
    expect(out).toBe('{==词==}{>>same<<} 和点批注{>>改<<}。\n')
  })
})
