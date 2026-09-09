import { describe, expect, it } from 'vitest'
import { fileViewFor, isValidFileView } from './file-views'
import type { FileViewContribution, FileViewSelector, PluginManifest } from './types'
import validationFixtures from '../../../protocol/fixtures/file-view-validation.json'

const view = (over: Partial<FileViewContribution> = {}): FileViewContribution => ({
  id: 'timeline', entry: 'index.html',
  selectors: [{ file_extensions: ['md'], frontmatter: { type: ['timeline'] } }],
  ...over,
})
const manifest = (views: FileViewContribution[] = [view()], id = 'notemd.timeline'): PluginManifest => ({
  id, name: id, version: '1.0.0', binary: '', host_capabilities: [], file_views: views,
})
const doc = (over: Partial<{ path: string; kind: string; content: string }> = {}) => ({
  path: '/vault/diary/2026-09-09.timeline.md', kind: 'markdown', content: '---\ntype: timeline\n---\n# Day', ...over,
})
const expected = { pluginId: 'notemd.timeline', viewId: 'timeline', entry: 'index.html' }
const matchSelector = (selector: FileViewSelector, document = doc()) => fileViewFor(document, [manifest([view({ selectors: [selector] })])])

describe('fileViewFor matching', () => {
  it('routes the timeline manifest without changing the host document', () => {
    const document = doc()
    expect(fileViewFor(document, [manifest()])).toEqual(expected)
    expect(document).toEqual(doc())
    expect(fileViewFor(doc({ content: '---\ntype: journal\n---' }), [manifest()])).toBeNull()
    expect(fileViewFor(doc(), [])).toBeNull()
  })

  it('uses OR between selectors and array values and AND between fields and frontmatter keys', () => {
    const selectors: FileViewContribution['selectors'] = [{ file_extensions: ['txt'] }, {
      file_extensions: ['json', '.MD'], file_name_patterns: ['*.unknown', '*.timeline.md'],
      path_patterns: ['**/diary/*.md'], frontmatter: { type: ['journal', 'timeline'], published: [true] },
    }]
    const document = doc({ content: '---\ntype: timeline\npublished: true\n---' })
    expect(fileViewFor(document, [manifest([view({ selectors })])])).toEqual(expected)
    expect(fileViewFor(doc(), [manifest([view({ selectors })])])).toBeNull()
    expect(fileViewFor(doc({ path: '/vault/plain.txt', kind: 'code', content: '' }), [manifest([view({ selectors })])])).toEqual(expected)
    expect(fileViewFor({ ...document, path: '/vault/inbox/day.md' }, [manifest([view({ selectors })])])).toBeNull()
  })

  it.each(['markdown', 'mdx', 'html', 'code', 'spreadsheet', 'base'])('supports a native %s document', (kind) => {
    expect(matchSelector({ file_name_patterns: ['*'] }, doc({ kind }))).toEqual(expected)
  })

  it.each(['canvas', 'image', 'custom', 'unknown', ''])('does not claim a %s document', (kind) => {
    expect(matchSelector({ file_name_patterns: ['*'] }, doc({ kind }))).toBeNull()
  })

  it('supports mixed case extensions and leading dots, but matches filename case exactly', () => {
    expect(matchSelector({ file_extensions: [' ..MD '] }, doc({ path: '/vault/NOTE.Md' }))).toEqual(expected)
    expect(matchSelector({ file_name_patterns: ['*.md'] }, doc({ path: '/vault/NOTE.MD' }))).toBeNull()
    expect(matchSelector({ file_extensions: ['md'] }, doc({ path: '/vault/md' }))).toBeNull()
    expect(matchSelector({ file_name_patterns: ['README'] }, doc({ path: '/vault/README' }))).toEqual(expected)
  })

  it.each([
    ['**/diary/*.md', '/vault/diary/day.md', true],
    ['**/diary/*.md', '/vault/diary/nested/day.md', false],
    ['/vault/**/day.md', '/vault/day.md', true],
    ['/vault/**/day.md', '/vault/deep/nested/day.md', true],
    ['/vault/**/day.md', '/vault/nestedday.md', false],
    ['/vault/**/day.md', '/other/vault/day.md', false],
    ['/vault/*/day.md', '/vault/deep/nested/day.md', false],
    ['/vault/*/day.md', '/vault/deep/day.md', true],
    ['/vault/**', '/vault/deep/nested/day.md', true],
    ['/vault/**/diary/**/?.md', '/vault/diary/文.md', true],
    ['/vault/**/diary/**/?.md', '/vault/deep/diary/nested/文.md', true],
    ['/vault/diary/day.md', '/vault/Diary/day.md', false],
  ])('matches %s against %s → %s', (pattern, path, matches) => {
    expect(Boolean(matchSelector({ path_patterns: [pattern] }, doc({ path })))).toBe(matches)
  })

  it('treats all non-wildcard characters literally, with no regex or brace syntax', () => {
    expect(matchSelector({ file_name_patterns: ['[draft](1).md'] }, doc({ path: '/vault/[draft](1).md' }))).toEqual(expected)
    expect(matchSelector({ file_name_patterns: ['[ab].md'] }, doc({ path: '/vault/a.md' }))).toBeNull()
    expect(matchSelector({ file_name_patterns: ['{a,b}.md'] }, doc({ path: '/vault/a.md' }))).toBeNull()
    expect(matchSelector({ file_name_patterns: ['(a+)+.md'] }, doc({ path: '/vault/aaaa.md' }))).toBeNull()
  })

  it('normalizes Windows and UNC paths; relative paths still support filename rules', () => {
    expect(matchSelector({ path_patterns: ['C:/vault/**/day.md'] }, doc({ path: 'C:\\vault\\diary\\day.md' }))).toEqual(expected)
    expect(matchSelector({ path_patterns: ['//server/share/**/day.md'] }, doc({ path: '\\\\server\\share\\day.md' }))).toEqual(expected)
    expect(matchSelector({ path_patterns: ['**/day.md'] }, doc({ path: 'diary/day.md' }))).toBeNull()
    expect(matchSelector({ file_name_patterns: ['day.md'] }, doc({ path: 'diary/day.md' }))).toEqual(expected)
  })

  it('matches trimmed case-insensitive string scalars and typed booleans/numbers', () => {
    const content = '\uFEFF---\r\ntype: " TIMELINE "\r\ncount: 2\r\nready: false\r\n---\r\n# Day'
    expect(matchSelector({ frontmatter: { type: ['timeline'], count: [2], ready: [false] } }, doc({ content }))).toEqual(expected)
    expect(matchSelector({ frontmatter: { count: ['2'] } }, doc({ content }))).toBeNull()
    expect(matchSelector({ frontmatter: { ready: ['false'] } }, doc({ content }))).toBeNull()
    expect(matchSelector({ frontmatter: { count: [true] } }, doc({ content }))).toBeNull()
  })

  it('only reads top-level literal properties, without traversing dotted keys or YAML aliases', () => {
    expect(matchSelector({ frontmatter: { 'view.type': ['timeline'] } }, doc({ content: '---\nview.type: timeline\n---' }))).toEqual(expected)
    expect(matchSelector({ frontmatter: { 'view.type': ['timeline'] } }, doc({ content: '---\nview:\n  type: timeline\n---' }))).toBeNull()
    expect(matchSelector({ frontmatter: { type: ['timeline'] } }, doc({ content: '---\nother: &type timeline\ntype: *type\n---' }))).toBeNull()
    expect(matchSelector({ frontmatter: { constructor: ['timeline'] } }, doc())).toBeNull()
  })

  it.each([
    '# Day\n---\ntype: timeline\n---',
    '---\ntype: timeline\n# Missing closing fence',
    '---\ntype: timeline\n---oops',
    '---\ntype: timeline\ntype: journal\n---',
    '---\ntype: [timeline]\n---',
    '---\ntype: { name: timeline }\n---',
    '---\n- type: timeline\n---',
    '---\ntype: [broken\n---',
    '---\ntype: null\n---',
    '---\ntype: 123\n---',
    '---\ntype: .inf\n---',
  ])('does not claim malformed or unsupported metadata: %s', (content) => {
    expect(fileViewFor(doc({ content }), [manifest()])).toBeNull()
    expect(matchSelector({ file_extensions: ['md'] }, doc({ content }))).toEqual(expected)
  })

  it('bounds metadata parsing while allowing a large body and unrelated file rules', () => {
    expect(fileViewFor(doc({ content: doc().content + 'x'.repeat(200_000) }), [manifest()])).toEqual(expected)
    const content = `---\n#${'x'.repeat(128 * 1024)}\ntype: timeline\n---`
    expect(fileViewFor(doc({ content }), [manifest()])).toBeNull()
    expect(matchSelector({ file_extensions: ['md'] }, doc({ content }))).toEqual(expected)
    const before = '---\ntype: timeline\n#'
    const fakeFence = before + 'x'.repeat(128 * 1024 - before.length - 4) + '\n---oops'
    expect(fileViewFor(doc({ content: fakeFence }), [manifest()])).toBeNull()
  })

  it('uses priority then stable plugin/view IDs, independent of manifest order', () => {
    const low = manifest([view({ priority: 0 })], 'a.plugin')
    const high = manifest([view({ priority: 1 })], 'z.plugin')
    expect(fileViewFor(doc(), [low, high])?.pluginId).toBe('z.plugin')
    const tied = manifest([view()], 'b.plugin')
    expect(fileViewFor(doc(), [tied, low])?.pluginId).toBe('a.plugin')
    expect(fileViewFor(doc(), [low, tied])?.pluginId).toBe('a.plugin')
    expect(fileViewFor(doc(), [manifest([view({ id: 'z-view' }), view({ id: 'a-view' })])])?.viewId).toBe('a-view')
    expect(fileViewFor(doc(), [manifest([view({ priority: 1000, selectors: [{ file_extensions: ['json'] }] }), view({ id: 'other', priority: -1000 })])])?.viewId).toBe('other')
  })

  it('keeps legacy extension editors outside the read-only route', () => {
    expect(fileViewFor(doc(), [{ ...manifest([]), custom_editors: [{ id: 'base', entry: 'index.html', file_extensions: ['md'] }] }])).toBeNull()
  })
})

describe('fileViewFor invalid rules and work limits', () => {
  it.each(validationFixtures)('shares the Rust manifest validation contract: $name', ({ view, valid }) => {
    expect(isValidFileView(view)).toBe(valid)
  })

  it.each([
    null, [], { id: '' }, { id: 'Timeline' }, { id: 'bad.id' }, { id: 'a'.repeat(129) },
    { priority: NaN }, { priority: Infinity }, { priority: null }, { priority: 0.5 }, { priority: 1001 }, { priority: -1001 },
    { selectors: null }, { selectors: [] }, { selectors: [{}] }, { selectors: [null] },
    { selectors: [{ file_extensions: [] }] }, { selectors: [{ file_extensions: [''] }] },
    { selectors: [{ file_extensions: ['...'] }] }, { selectors: [{ file_extensions: ['my.ext'] }] },
    { selectors: [{ file_extensions: [12] }] }, { selectors: [{ file_extensions: ['m/d'] }] },
    { selectors: [{ file_name_patterns: [''] }] }, { selectors: [{ file_name_patterns: ['diary/*.md'] }] },
    { selectors: [{ path_patterns: ['C:\\*.md'] }] }, { selectors: [{ path_patterns: ['x'.repeat(257)] }] },
    { selectors: [{ frontmatter: {} }] }, { selectors: [{ frontmatter: [] }] }, { selectors: [{ frontmatter: null }] },
    { selectors: [{ frontmatter: { ' ': ['timeline'] } }] }, { selectors: [{ frontmatter: { ['x'.repeat(129)]: ['timeline'] } }] },
    { selectors: [{ frontmatter: { type: [] } }] }, { selectors: [{ frontmatter: { type: [null] } }] },
    { selectors: [{ frontmatter: { type: [{}] } }] }, { selectors: [{ frontmatter: { type: [['timeline']] } }] },
    { selectors: [{ frontmatter: { type: [' '] } }] }, { selectors: [{ frontmatter: { type: [Infinity] } }] },
    { selectors: [{ frontmatter: { type: ['x'.repeat(257)] } }] },
    { selectors: [{ file_extensions: ['md'], unknown: true }] }, { unknown: true },
  ])('ignores an invalid contribution instead of broadening its match: %j', (over) => {
    const malformed = over && !Array.isArray(over) ? { ...view(), ...over } : over
    expect(fileViewFor(doc(), [manifest([malformed as never])])).toBeNull()
    expect(fileViewFor(doc(), [manifest([malformed as never, view({ id: 'valid' })])])?.viewId).toBe('valid')
  })

  it.each(['', '/index.html', '../index.html', 'ui/../index.html', './index.html', 'ui/./index.html', 'ui//index.html', 'ui\\index.html', 'https://example.com/index.html', 'index.html?x', 'index.html#x', '%2e/index.html', 'index.htm', 'index.HTML', `${'x'.repeat(252)}.html`])('rejects unsafe entry: %s', (entry) => {
    expect(fileViewFor(doc(), [manifest([view({ entry })])])).toBeNull()
  })

  it('enforces collection bounds without partially accepting an invalid rule', () => {
    expect(fileViewFor(doc(), [manifest(Array.from({ length: 33 }, () => view()))])).toBeNull()
    expect(fileViewFor(doc(), [manifest([view({ selectors: Array.from({ length: 33 }, () => ({ file_extensions: ['md'] })) as never })])])).toBeNull()
    expect(matchSelector({ file_extensions: Array(33).fill('md') as never })).toBeNull()
    expect(matchSelector({ frontmatter: { type: Array(33).fill('timeline') } })).toBeNull()
    const frontmatter = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, ['timeline']]))
    expect(matchSelector({ frontmatter })).toBeNull()
  })

  it('rejects ambiguous duplicate view IDs within a plugin', () => {
    expect(fileViewFor(doc(), [manifest([view(), view()])])).toBeNull()
    expect(fileViewFor(doc(), [manifest([view(), view()]), manifest([view()], 'valid.plugin')])?.pluginId).toBe('valid.plugin')
  })

  it('counts Unicode code points consistently with manifest validation', () => {
    const value = '文😀'.repeat(128)
    expect(matchSelector({ frontmatter: { type: [value] } }, doc({ content: `---\ntype: ${value}\n---` }))).toEqual(expected)
    expect(matchSelector({ frontmatter: { type: [value + '字'] } }, doc({ content: `---\ntype: ${value}字\n---` }))).toBeNull()
  })

  it('rejects extreme document paths before attempting matching', () => {
    expect(matchSelector({ file_extensions: ['md'] }, doc({ path: `/${'a'.repeat(16_384)}.md` }))).toBeNull()
  })

  it('handles adversarial wildcard sequences without recursive backtracking', () => {
    const pattern = `${'*a'.repeat(120)}b.md`
    expect(matchSelector({ file_name_patterns: [pattern] }, doc({ path: `/${'a'.repeat(4_000)}.md` }))).toBeNull()
  }, 1000)

  it('agrees with an independent regex oracle for bounded randomized path patterns', () => {
    // Regex is deliberately confined to short test inputs. Production matching
    // must never use this oracle's potentially backtracking implementation.
    function oracle(pattern: string, path: string): boolean {
      const segments = pattern.split('/')
      const expression = segments.map((segment, index) => {
        if (/^\*{2,}$/.test(segment) && index < segments.length - 1) return '(?:.*/)?'
        const body = segment.match(/\*+|\?|[^*?]+/g)?.map((token) => {
          if (token === '?') return '[^/]'
          if (token[0] === '*') return token.length === 1 ? '[^/]*' : '.*'
          return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        }).join('') ?? ''
        return body + (index < segments.length - 1 ? '/' : '')
      }).join('')
      return new RegExp(`^${expression}$`, 'u').test(path)
    }
    let seed = 0x51f17e
    function random(max: number): number {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return (seed >>> 0) % max
    }
    const segments = ['a', 'b', '*', '?', '**', '***', 'a*b', '*a*', 'a**b', '**a', 'a?', '文']
    const names = ['a', 'b', 'aa', 'ab', 'ba', '文', 'a文']
    for (let i = 0; i < 4_000; i++) {
      const pattern = (random(2) ? '/' : '**/') + Array.from({ length: 1 + random(4) }, () => segments[random(segments.length)]).join('/')
      const path = '/' + Array.from({ length: 1 + random(4) }, () => names[random(names.length)]).join('/')
      expect(Boolean(matchSelector({ path_patterns: [pattern] }, doc({ path }))), `${pattern} against ${path}`).toBe(oracle(pattern, path))
    }
  })
})
