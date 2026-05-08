import { describe, it, expect } from 'vitest'
import {
  shareHeaderLabel, isoDateStamp, viewportMetaTag, themeCssBlock,
  guardSize, MAX_HTML_BYTES,
} from './share-baker'

describe('shareHeaderLabel', () => {
  it('uses basename for normal paths', () => {
    expect(shareHeaderLabel('/Users/bruce/notes/foo.md')).toBe('foo.md')
  })
  it('keeps dotfile name intact', () => {
    expect(shareHeaderLabel('/proj/.env')).toBe('.env')
  })
  it('uses "Untitled" for null path', () => {
    expect(shareHeaderLabel(null)).toBe('Untitled')
  })
})

describe('isoDateStamp', () => {
  it('produces YYYY-MM-DD from a Date', () => {
    expect(isoDateStamp(new Date('2026-05-08T10:30:00Z'))).toBe('2026-05-08')
  })
})

describe('viewportMetaTag', () => {
  it('returns the standard width=device-width tag', () => {
    expect(viewportMetaTag()).toBe(
      '<meta name="viewport" content="width=device-width, initial-scale=1">'
    )
  })
})

describe('themeCssBlock', () => {
  it('contains light defaults and a prefers-color-scheme dark override', () => {
    const css = themeCssBlock()
    expect(css).toContain('color-scheme:')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain('img { max-width: 100%')
    expect(css).toContain('pre { overflow-x: auto')
  })
})

describe('guardSize', () => {
  it('passes through small payloads', () => {
    expect(() => guardSize('x'.repeat(1000))).not.toThrow()
  })
  it('throws a tagged error for >25MB payloads', () => {
    const big = 'x'.repeat(MAX_HTML_BYTES + 1)
    expect(() => guardSize(big)).toThrow(/^share_too_large:\d+$/)
  })
})

import { renderTabBody } from './share-baker'
import type { Tab } from '../tabs.svelte'

const fakeTab = (over: Partial<Tab> = {}): Tab => ({
  id: 'x',
  filePath: '/tmp/foo.md',
  title: 'foo.md',
  initialContent: '',
  currentContent: '',
  mode: 'source',
  kind: 'markdown',
  externalState: 'fresh',
  externalBannerDismissed: false,
  lastKnownMtime: 0,
  lastKnownHash: '',
  ...over,
})

describe('renderTabBody', () => {
  it('renders markdown headings to <h1>/<h2>', async () => {
    const t = fakeTab({ currentContent: '# Hello\n\n## World\n\nbody' })
    const body = await renderTabBody(t)
    expect(body).toMatch(/<h1[^>]*>Hello/i)
    expect(body).toMatch(/<h2[^>]*>World/i)
  })

  it('passes HTML tabs through unchanged in body', async () => {
    const t = fakeTab({
      kind: 'html', filePath: '/tmp/foo.html', title: 'foo.html',
      currentContent: '<p>raw</p>',
    })
    const body = await renderTabBody(t)
    expect(body).toContain('<p>raw</p>')
  })

  it('wraps code-kind tabs in a highlighted code block', async () => {
    const t = fakeTab({
      kind: 'code', filePath: '/tmp/foo.py', title: 'foo.py', language: 'python',
      currentContent: 'def f():\n    return 1',
    })
    const body = await renderTabBody(t)
    expect(body).toMatch(/<pre>/)
    expect(body).toContain('language-python')
  })

  it('highlights fenced code blocks via highlight.js', async () => {
    const t = fakeTab({ currentContent: '```js\nconst x = 1\n```' })
    const body = await renderTabBody(t)
    expect(body).toContain('hljs language-js')
  })
})
