import { describe, it, expect } from 'vitest'
import {
  extractH1FromMarkdown,
  suggestedPdfFilename,
  buildPdfTitle,
  htmlEscape,
} from './pdf-export'

describe('extractH1FromMarkdown', () => {
  it('returns the first ATX H1', () => {
    expect(extractH1FromMarkdown('# Hello World\n\ntext')).toBe('Hello World')
  })
  it('skips leading whitespace and finds H1', () => {
    expect(extractH1FromMarkdown('\n\n# Title\nbody')).toBe('Title')
  })
  it('returns null when no H1 present', () => {
    expect(extractH1FromMarkdown('## sub\nplain text')).toBe(null)
    expect(extractH1FromMarkdown('')).toBe(null)
  })
  it('does not match setext-style underline (===)', () => {
    expect(extractH1FromMarkdown('Title\n=====\nbody')).toBe(null)
  })
  it('trims trailing whitespace and hash', () => {
    expect(extractH1FromMarkdown('#   Padded   #\n')).toBe('Padded')
  })
  it('finds H1 even when not at top (after frontmatter etc.)', () => {
    expect(extractH1FromMarkdown('---\nfoo: bar\n---\n\n# After Front')).toBe('After Front')
  })
})

describe('suggestedPdfFilename', () => {
  it('replaces extension with .pdf', () => {
    expect(suggestedPdfFilename('/tmp/foo.md')).toBe('foo.pdf')
    expect(suggestedPdfFilename('report.markdown')).toBe('report.pdf')
  })
  it('handles names without extension', () => {
    expect(suggestedPdfFilename('Dockerfile')).toBe('Dockerfile.pdf')
    expect(suggestedPdfFilename('/path/to/Makefile')).toBe('Makefile.pdf')
  })
  it('takes only the basename', () => {
    expect(suggestedPdfFilename('/Users/foo/Documents/notes.md')).toBe('notes.pdf')
  })
  it('handles dotfiles by appending .pdf', () => {
    expect(suggestedPdfFilename('/proj/.env')).toBe('.env.pdf')
  })
})

describe('buildPdfTitle', () => {
  const tab = (overrides: Record<string, unknown> = {}) => ({
    id: 'x', filePath: '/tmp/foo.md', title: 'foo.md',
    initialContent: '', currentContent: '', mode: 'source' as const,
    kind: 'markdown' as const,
    externalState: 'fresh' as const,
    externalBannerDismissed: false,
    lastKnownMtime: 0, lastKnownHash: '',
    ...overrides,
  })

  it('uses H1 when present in markdown', () => {
    expect(buildPdfTitle(tab({ currentContent: '# My Doc\nbody' }))).toBe('My Doc')
  })
  it('falls back to basename without extension', () => {
    expect(buildPdfTitle(tab({ currentContent: 'no headings here' }))).toBe('foo')
  })
  it('uses basename for HTML tabs (no markdown parsing)', () => {
    expect(buildPdfTitle(tab({
      filePath: '/tmp/page.html', kind: 'html',
      currentContent: '<h1>Inside HTML</h1>',
    }))).toBe('page')
  })
})

describe('htmlEscape', () => {
  it('escapes the four html-significant characters', () => {
    expect(htmlEscape('<a href="x">&copy;</a>'))
      .toBe('&lt;a href=&quot;x&quot;&gt;&amp;copy;&lt;/a&gt;')
  })
  it('passes plain text through', () => {
    expect(htmlEscape('Hello World')).toBe('Hello World')
  })
})
