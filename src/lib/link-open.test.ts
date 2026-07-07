import { describe, it, expect } from 'vitest'
import { classifyLink } from './link-open'

const BASE = '/Users/me/notes/index.md'

describe('classifyLink', () => {
  it('ignores in-document anchors and empty hrefs', () => {
    expect(classifyLink('#section', BASE)).toEqual({ kind: 'ignore' })
    expect(classifyLink('   ', BASE)).toEqual({ kind: 'ignore' })
  })

  it('routes external URL schemes to the browser', () => {
    expect(classifyLink('https://example.com/x', BASE)).toEqual({ kind: 'browser', url: 'https://example.com/x' })
    expect(classifyLink('http://a.b', BASE)).toEqual({ kind: 'browser', url: 'http://a.b' })
    expect(classifyLink('mailto:a@b.com', BASE)).toEqual({ kind: 'browser', url: 'mailto:a@b.com' })
    expect(classifyLink('tel:+123', BASE)).toEqual({ kind: 'browser', url: 'tel:+123' })
  })

  it('resolves relative editable files to an edit action (new tab)', () => {
    expect(classifyLink('sibling.md', BASE)).toEqual({ kind: 'edit', path: '/Users/me/notes/sibling.md' })
    expect(classifyLink('./sibling.md', BASE)).toEqual({ kind: 'edit', path: '/Users/me/notes/sibling.md' })
    expect(classifyLink('../other/x.txt', BASE)).toEqual({ kind: 'edit', path: '/Users/me/other/x.txt' })
  })

  it('treats absolute editable paths as edit actions', () => {
    expect(classifyLink('/tmp/a.md', BASE)).toEqual({ kind: 'edit', path: '/tmp/a.md' })
  })

  it('strips query and fragment from local paths', () => {
    expect(classifyLink('sibling.md#heading', BASE)).toEqual({ kind: 'edit', path: '/Users/me/notes/sibling.md' })
    expect(classifyLink('sibling.md?v=2', BASE)).toEqual({ kind: 'edit', path: '/Users/me/notes/sibling.md' })
  })

  it('routes images and unknown local files to the system default app', () => {
    expect(classifyLink('pic.png', BASE)).toEqual({ kind: 'system', path: '/Users/me/notes/pic.png' })
    expect(classifyLink('doc.pdf', BASE)).toEqual({ kind: 'system', path: '/Users/me/notes/doc.pdf' })
  })

  it('handles file:// URLs as local paths', () => {
    expect(classifyLink('file:///tmp/a.md', BASE)).toEqual({ kind: 'edit', path: '/tmp/a.md' })
    expect(classifyLink('file:///tmp/pic.png', BASE)).toEqual({ kind: 'system', path: '/tmp/pic.png' })
  })

  it('ignores relative links when no base path is available (untitled buffer)', () => {
    expect(classifyLink('sibling.md', '')).toEqual({ kind: 'ignore' })
    expect(classifyLink('sibling.md', undefined)).toEqual({ kind: 'ignore' })
  })
})
