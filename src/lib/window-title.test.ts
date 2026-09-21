import { describe, it, expect } from 'vitest'
import { displayTitleForDocument, windowTitleFor } from './window-title'

describe('windowTitleFor', () => {
  it('is the bare app name when no single document is showing', () => {
    expect(windowTitleFor(null, false)).toBe('note.md')
    expect(windowTitleFor(null, true)).toBe('note.md')
  })
  it('shows the document name', () => {
    expect(windowTitleFor('foo.md', false)).toBe('foo.md — note.md')
  })
  it('marks a mirrored source with ↔', () => {
    expect(windowTitleFor('foo.md', true)).toBe('↔ foo.md — note.md')
  })

  it('uses frontmatter or the book directory as a typeset display title', () => {
    expect(displayTitleForDocument({
      filePath: '/vault/books/Make Your Brain Work/book.typeset.md',
      title: 'book.typeset.md',
      currentContent: '---\ntitle: Make Your Brain Work\n---\n# Chapter',
    })).toBe('Make Your Brain Work')
    expect(displayTitleForDocument({
      filePath: '/vault/books/目录书名/book.typeset.md',
      title: 'book.typeset.md',
      currentContent: '# Chapter',
    })).toBe('目录书名')
    expect(displayTitleForDocument({
      filePath: '/vault/books/custom.typeset.md',
      title: 'custom.typeset.md',
      currentContent: '---\ntitle: Custom Book\n---\n# Chapter',
    })).toBe('Custom Book')
  })

  it('keeps real filenames for ordinary documents and rejects unsafe metadata titles', () => {
    expect(displayTitleForDocument({ filePath: '/vault/book.md', title: 'book.md', currentContent: '---\ntitle: Other\n---' })).toBe('book.md')
    expect(displayTitleForDocument({
      filePath: '/vault/Safe/book.typeset.md',
      title: 'book.typeset.md',
      currentContent: '---\ntitle: "bad\\u0007title"\n---',
    })).toBe('Safe')
  })
})
