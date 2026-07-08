/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest'
import { buildFrontmatterDom } from './frontmatter-view'

describe('buildFrontmatterDom', () => {
  it('renders key: value pairs as a two-column table', () => {
    const el = buildFrontmatterDom('title: Hello\nauthor: Bruce')
    expect(el.tagName).toBe('TABLE')
    const rows = el.querySelectorAll('tr')
    expect(rows.length).toBe(2)
    expect(rows[0].querySelector('.fm-key')?.textContent).toBe('title')
    expect(rows[0].querySelector('.fm-val')?.textContent).toBe('Hello')
    expect(rows[1].querySelector('.fm-key')?.textContent).toBe('author')
    expect(rows[1].querySelector('.fm-val')?.textContent).toBe('Bruce')
  })

  it('renders a list value as a <ul> with one item per <li>', () => {
    const el = buildFrontmatterDom('tags:\n  - a\n  - b\n  - c')
    const items = el.querySelectorAll('.fm-val ul.fm-list > li')
    expect(items.length).toBe(3)
    expect(Array.from(items).map(li => li.textContent)).toEqual(['a', 'b', 'c'])
  })

  it('preserves newlines in a multi-line (block scalar) string', () => {
    const el = buildFrontmatterDom('desc: |\n  line one\n  line two\n')
    const val = el.querySelector('.fm-val')!
    expect(val.textContent).toContain('line one\nline two')
  })

  it('renders a nested object as key: value lines', () => {
    const el = buildFrontmatterDom('meta:\n  a: 1\n  b: 2')
    const nested = el.querySelector('.fm-val .fm-nested')!
    expect(nested).toBeTruthy()
    const lines = nested.querySelectorAll('.fm-nested-line')
    expect(lines.length).toBe(2)
    expect(lines[0].textContent).toBe('a: 1')
  })

  it('falls back to wrapped raw YAML for a root scalar', () => {
    const el = buildFrontmatterDom('just a bare string')
    expect(el.tagName).toBe('PRE')
    expect(el.className).toBe('frontmatter-raw')
    expect(el.textContent).toBe('just a bare string')
  })

  it('falls back to raw YAML on malformed input instead of throwing', () => {
    const el = buildFrontmatterDom('key: "unterminated\n  - broken: [')
    expect(el.className).toBe('frontmatter-raw')
  })
})
