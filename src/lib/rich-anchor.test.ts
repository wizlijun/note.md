// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { schema } from 'prosemirror-schema-basic'
import type { EditorView } from 'prosemirror-view'
import { findRichAnchorTarget } from './rich-anchor'

function fixture(titles: string[]) {
  const doc = schema.node('doc', null, titles.map((title) =>
    schema.node('heading', { level: 2 }, title ? schema.text(title) : undefined)))
  const elements = titles.map((title) => {
    const element = document.createElement('h2')
    element.textContent = title
    return element
  })
  const domByPos = new Map<number, HTMLElement>()
  doc.forEach((_node, pos, index) => domByPos.set(pos, elements[index]))
  const view = { state: { doc }, nodeDOM: (pos: number) => domByPos.get(pos) } as unknown as EditorView
  return { view, elements }
}

describe('findRichAnchorTarget', () => {
  it('matches the actual numbered Chinese heading with punctuation removed', () => {
    const { view, elements } = fixture(['1. 先读:法条速查(人话版)'])
    expect(findRichAnchorTarget(view, '#1-先读法条速查人话版')).toBe(elements[0])
  })

  it('preserves separate spaces around removed symbols in the uploaded document', () => {
    const { view, elements } = fixture(['4. 三类说话人 × 三条关联路径', '7.1 判例对照：赢在哪、输在哪'])
    expect(findRichAnchorTarget(view, '#4-三类说话人--三条关联路径')).toBe(elements[0])
    expect(findRichAnchorTarget(view, '#71-判例对照赢在哪输在哪')).toBe(elements[1])
  })

  it('decodes the fragment exactly once and preserves literal underscores and hyphens', () => {
    const { view, elements } = fixture(['API_v2 - 中文'])
    const slug = 'api_v2---中文'
    expect(findRichAnchorTarget(view, `#${encodeURIComponent(slug)}`)).toBe(elements[0])
    expect(findRichAnchorTarget(view, `#${encodeURIComponent(encodeURIComponent(slug))}`)).toBeNull()
  })

  it('uses document text even when live-preview decorates the rendered heading', () => {
    const { view, elements } = fixture(['1. 先读:法条速查(人话版)'])
    elements[0].innerHTML = '<span class="syntax-md-prefix">## </span>1. 先读:<span class="syntax-md-mark">**</span>法条速查<span class="syntax-md-mark">**</span>(人话版)'
    expect(findRichAnchorTarget(view, '#1-先读法条速查人话版')).toBe(elements[0])
    expect(view.state.doc.firstChild?.textContent).toBe('1. 先读:法条速查(人话版)')
  })

  it('disambiguates repeated headings without colliding with existing suffixed titles', () => {
    const { view, elements } = fixture(['Repeat', 'Repeat', 'Repeat-1', 'Repeat'])
    expect(findRichAnchorTarget(view, '#repeat')).toBe(elements[0])
    expect(findRichAnchorTarget(view, '#repeat-1')).toBe(elements[1])
    expect(findRichAnchorTarget(view, '#repeat-1-1')).toBe(elements[2])
    expect(findRichAnchorTarget(view, '#repeat-2')).toBe(elements[3])
  })

  it.each(['#', '#missing', '#%ZZ', 'https://example.com/#repeat', './file.md#repeat'])(
    'does not resolve invalid, missing or non-local fragment %s', (href) => {
      const { view } = fixture(['Repeat'])
      expect(findRichAnchorTarget(view, href)).toBeNull()
    },
  )
})
