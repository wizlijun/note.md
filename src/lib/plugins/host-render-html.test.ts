/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  htmlEscape,
  extractH1FromMarkdown,
  buildPdfTitle,
  hasMathContent,
  inlineImages,
  __setImageReaderForTests,
} from './host-render-html'

describe('htmlEscape', () => {
  it('escapes the four critical characters', () => {
    expect(htmlEscape('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e')
  })
  it('passes ASCII through unchanged', () => {
    expect(htmlEscape('plain text 123')).toBe('plain text 123')
  })
})

describe('extractH1FromMarkdown', () => {
  it('returns the first H1 text', () => {
    expect(extractH1FromMarkdown('# Hello\n\nbody')).toBe('Hello')
  })
  it('returns null when no H1 present', () => {
    expect(extractH1FromMarkdown('\n\nNo heading here')).toBeNull()
  })
  it('strips trailing closing #s', () => {
    expect(extractH1FromMarkdown('# Title ##')).toBe('Title')
  })
  it('does NOT recognise setext (===) underlines', () => {
    expect(extractH1FromMarkdown('Title\n===')).toBeNull()
  })
})

describe('buildPdfTitle', () => {
  it('uses H1 when present in markdown tab', () => {
    expect(buildPdfTitle({
      kind: 'markdown', currentContent: '# H1\nbody', filePath: '/tmp/foo.md',
    } as never)).toBe('H1')
  })
  it('falls back to basename without extension', () => {
    expect(buildPdfTitle({
      kind: 'markdown', currentContent: 'no heading', filePath: '/tmp/foo.md',
    } as never)).toBe('foo')
  })
  it('keeps the dotfile basename intact', () => {
    expect(buildPdfTitle({
      kind: 'markdown', currentContent: '', filePath: '/proj/.env',
    } as never)).toBe('.env')
  })
  it('uses basename for html tab even with H1 in body', () => {
    expect(buildPdfTitle({
      kind: 'html', currentContent: '<h1>X</h1>', filePath: '/tmp/page.html',
    } as never)).toBe('page')
  })
})

describe('hasMathContent', () => {
  it('detects $ inline math', () => {
    expect(hasMathContent('cost is $E=mc^2$ in physics')).toBe(true)
  })
  it('detects $$ display math', () => {
    expect(hasMathContent('text\n$$\\int_0^1 x dx$$\n')).toBe(true)
  })
  it('detects \\(...\\)', () => {
    expect(hasMathContent('inline \\(a+b\\)')).toBe(true)
  })
  it('returns false for plain prose', () => {
    expect(hasMathContent('no math here, just words.')).toBe(false)
  })
  it('returns false for prose with isolated dollar signs', () => {
    expect(hasMathContent('cost is $5 today')).toBe(false)
  })
})

describe('inlineImages', () => {
  beforeEach(() => __setImageReaderForTests(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])))
  afterEach(() => __setImageReaderForTests(null))

  it('replaces relative-path <img> with data: URL', async () => {
    const html = '<p><img src="./foo.png" alt="x"></p>'
    const out = await inlineImages(
      html, '/Users/bruce/notes/doc.md',
      async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    )
    expect(out).toMatch(/data:image\/png;base64,[A-Za-z0-9+/=]+/)
  })
  it('leaves https:// images untouched', async () => {
    const html = '<p><img src="https://x.test/a.png"></p>'
    const out = await inlineImages(html, '/foo/bar.md', async () => new Uint8Array())
    expect(out).toContain('https://x.test/a.png')
    expect(out).not.toContain('data:')
  })
  it('replaces unreadable image with <em>alt</em>', async () => {
    const html = '<p><img src="./missing.png" alt="oops"></p>'
    const out = await inlineImages(html, '/x.md', async () => { throw new Error('enoent') })
    expect(out).toContain('<em>oops</em>')
  })
  it('returns input unchanged when tabPath is null', async () => {
    const html = '<p><img src="./x.png"></p>'
    const out = await inlineImages(html, null, async () => new Uint8Array())
    expect(out).toBe(html)
  })
})
