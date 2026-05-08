import { describe, it, expect } from 'vitest'
import { renderFilenameTemplate } from './prompt'

describe('renderFilenameTemplate', () => {
  it('expands {stem}.pdf', () => {
    expect(renderFilenameTemplate('{stem}.pdf', '/Users/bruce/notes/foo.md')).toBe('foo.pdf')
  })
  it('expands {basename}', () => {
    expect(renderFilenameTemplate('{basename}.bak', '/x/foo.md')).toBe('foo.md.bak')
  })
  it('expands {ext}', () => {
    expect(renderFilenameTemplate('archive.{ext}.gz', '/p/file.tar')).toBe('archive.tar.gz')
  })
  it('expands {dir}', () => {
    expect(renderFilenameTemplate('{dir}/x.pdf', '/Users/bruce/notes/foo.md'))
      .toBe('/Users/bruce/notes/x.pdf')
  })
  it('keeps unknown placeholders as literal', () => {
    expect(renderFilenameTemplate('a-{wat}-b', '/x/foo.md')).toBe('a-{wat}-b')
  })
  it('treats dotfile as stemless basename', () => {
    expect(renderFilenameTemplate('{stem}.pdf', '/proj/.env')).toBe('.env.pdf')
  })
  it('falls back to "untitled" when filePath is null', () => {
    expect(renderFilenameTemplate('{stem}.pdf', null)).toBe('untitled.pdf')
  })
  it('falls back when filePath is empty string', () => {
    expect(renderFilenameTemplate('{stem}.pdf', '')).toBe('untitled.pdf')
  })
})
