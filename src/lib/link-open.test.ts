import { describe, it, expect, vi, beforeEach } from 'vitest'
import { classifyLink, resolveWikilinkPath, restoreWikilinks, newWikilinkFileText } from './link-open'

const humanActor = vi.fn()
vi.mock('./okf/identity', () => ({
  humanActor: (...a: unknown[]) => humanActor(...a),
}))

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

  it.each(['./', '/Users/me/notes/', 'file:///Users/me/notes/'])(
    'decodes Markdown URL paths from %s exactly once', (prefix) => {
      expect(classifyLink(`${prefix}The%20Simple%20Beauty/%E9%A3%9E%E9%92%93.md`, BASE))
        .toEqual({ kind: 'edit', path: '/Users/me/notes/The Simple Beauty/飞钓.md' })
      expect(classifyLink(`${prefix}literal%2520/100%25.md`, BASE))
        .toEqual({ kind: 'edit', path: '/Users/me/notes/literal%20/100%.md' })
      expect(classifyLink(`${prefix}part%23one%3F.md?view=1#section`, BASE))
        .toEqual({ kind: 'edit', path: '/Users/me/notes/part#one?.md' })
    },
  )

  it('decodes the link without decoding the current document filesystem path', () => {
    expect(classifyLink('./summary%20notes.md', '/vault/literal%20/index.md'))
      .toEqual({ kind: 'edit', path: '/vault/literal%20/summary notes.md' })
  })

  it('decodes image and PDF paths before handing them to the system', () => {
    expect(classifyLink('images/book%20cover.png', BASE))
      .toEqual({ kind: 'system', path: '/Users/me/notes/images/book cover.png' })
    expect(classifyLink('book%20sample.pdf', BASE))
      .toEqual({ kind: 'system', path: '/Users/me/notes/book sample.pdf' })
  })

  it.each(['100%.md', 'bad%2.md', 'bad%E4.md'])('keeps malformed escapes literal: %s', (name) => {
    expect(classifyLink(name, BASE)).toEqual({ kind: 'edit', path: `/Users/me/notes/${name}` })
    expect(classifyLink(`file:///tmp/${name}`, BASE)).toEqual({ kind: 'edit', path: `/tmp/${name}` })
  })

  it('leaves external URL encodings and wikilink names unchanged', () => {
    const url = 'https://example.com/book%20title?q=%23chapter#section'
    expect(classifyLink(url, BASE)).toEqual({ kind: 'browser', url })
    expect(resolveWikilinkPath('literal%20', BASE)).toBe('/Users/me/notes/literal%20.md')
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

describe('resolveWikilinkPath', () => {
  const BASE = '/Users/me/notes/index.md'

  it('resolves a bare name to a sibling .md file', () => {
    expect(resolveWikilinkPath('subagent-cwd-not-worktree', BASE))
      .toBe('/Users/me/notes/subagent-cwd-not-worktree.md')
  })

  it('keeps an explicit extension', () => {
    expect(resolveWikilinkPath('baz.md', BASE)).toBe('/Users/me/notes/baz.md')
  })

  it('supports subdirectories and alias syntax', () => {
    expect(resolveWikilinkPath('sub/bar', BASE)).toBe('/Users/me/notes/sub/bar.md')
    expect(resolveWikilinkPath('foo|Display Text', BASE)).toBe('/Users/me/notes/foo.md')
    expect(resolveWikilinkPath('../up/x', BASE)).toBe('/Users/me/up/x.md')
  })

  it('returns null for empty targets or unsaved documents', () => {
    expect(resolveWikilinkPath('', BASE)).toBe(null)
    expect(resolveWikilinkPath('  ', BASE)).toBe(null)
    expect(resolveWikilinkPath('foo', '')).toBe(null)
    expect(resolveWikilinkPath('foo', undefined)).toBe(null)
  })
})

describe('newWikilinkFileText — RichEditor.openWikilink 的可测试出口', () => {
  // 修的就是这个:点一个不存在的 [[wikilink]] 曾经直接 writeTextFile(abs, '')
  // 写出 0 字节文件,违反 OKF §4.1(必须有可解析 frontmatter + 非空 type)。
  // 组件本身不便挂载测试,所以把"算出要写的文本"这一段抽成纯异步函数,
  // 单独覆盖 RichEditor 里对同一段逻辑的调用点。
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('signs the new page via humanActor() and the text is not empty (0-byte 缺陷验证)', async () => {
    humanActor.mockResolvedValue('human:bruce')
    const text = await newWikilinkFileText('/Users/me/notes/新页面.md')

    expect(text.length).toBeGreaterThan(0)
    expect(text).toContain('generated:\n  by: human:bruce\n  at:')
    expect(text).toContain('title: 新页面')
  })

  it('writes no generated key when identity resolution fails, but still not empty', async () => {
    humanActor.mockRejectedValue(new Error('no identity'))
    const text = await newWikilinkFileText('/Users/me/notes/新页面.md')

    expect(text).not.toContain('generated')
    expect(text.length).toBeGreaterThan(0)
  })
})

describe('restoreWikilinks', () => {
  it('un-escapes serializer-escaped wikilink brackets', () => {
    expect(restoreWikilinks('see \\[\\[foo\\]\\] here')).toBe('see [[foo]] here')
  })

  it('preserves alias syntax', () => {
    expect(restoreWikilinks('\\[\\[foo|Bar\\]\\]')).toBe('[[foo|Bar]]')
  })

  it('is idempotent on already-clean wikilinks', () => {
    expect(restoreWikilinks('[[foo]] and [[a/b]]')).toBe('[[foo]] and [[a/b]]')
  })

  it('handles multiple wikilinks in one string', () => {
    expect(restoreWikilinks('\\[\\[a\\]\\] x \\[\\[b\\]\\]')).toBe('[[a]] x [[b]]')
  })
})
