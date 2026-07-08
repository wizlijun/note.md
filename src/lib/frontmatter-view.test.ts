/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest'
import { renderFrontmatter, buildFrontmatterDom } from './frontmatter-view'

describe('renderFrontmatter — rendering', () => {
  it('renders key: value pairs as a table with editable scalar cells', () => {
    const el = buildFrontmatterDom('title: Hello\nauthor: Bruce')
    const rows = el.querySelectorAll('.frontmatter-table tr')
    expect(rows.length).toBe(2)
    expect(rows[0].querySelector('.fm-key')?.textContent).toBe('title')
    const val = rows[0].querySelector('.fm-val') as HTMLElement
    expect(val.textContent).toBe('Hello')
    expect(val.getAttribute('contenteditable')).toBe('true')
  })

  it('renders a list value read-only as a <ul>', () => {
    const el = buildFrontmatterDom('tags:\n  - a\n  - b\n  - c')
    const items = el.querySelectorAll('.fm-val ul.fm-list > li')
    expect(items.length).toBe(3)
    expect(Array.from(items).map(li => li.textContent)).toEqual(['a', 'b', 'c'])
    // Complex values are not inline-editable.
    expect(el.querySelector('.fm-val')?.getAttribute('contenteditable')).toBeNull()
  })

  it('keeps a multi-line (block scalar) string read-only with newlines', () => {
    const el = buildFrontmatterDom('desc: |\n  line one\n  line two\n')
    const val = el.querySelector('.fm-val')!
    expect(val.textContent).toContain('line one\nline two')
    expect(val.getAttribute('contenteditable')).toBeNull()
  })

  it('renders non-key:value regions as markdown', () => {
    const raw = 'title: Hello\n\n> a quote line\n'
    const el = renderFrontmatter(raw)
    // kv table for title
    expect(el.querySelector('.frontmatter-table .fm-key')?.textContent).toBe('title')
    // md block rendered the blockquote
    const md = el.querySelector('.frontmatter-md')!
    expect(md.innerHTML).toContain('<blockquote>')
    expect(md.textContent).toContain('a quote line')
  })

  it('segments mixed content into multiple kv tables', () => {
    const raw = 'title: A\n\nprose\n\ndate: B\ntags:\n  - x\n'
    const el = renderFrontmatter(raw)
    expect(el.querySelectorAll('.frontmatter-table').length).toBe(2)
    expect(el.querySelectorAll('.frontmatter-md').length).toBe(1)
  })
})

describe('renderFrontmatter — editing', () => {
  it('writes an edited scalar back into the full raw YAML on blur', () => {
    const onChange = vi.fn()
    const raw = 'title: Hello\ncount: 3\n'
    const el = renderFrontmatter(raw, onChange)
    const countCell = Array.from(el.querySelectorAll('tr'))
      .find(tr => tr.querySelector('.fm-key')?.textContent === 'count')!
      .querySelector('.fm-val') as HTMLElement

    countCell.textContent = '5'
    countCell.dispatchEvent(new Event('blur'))

    expect(onChange).toHaveBeenCalledTimes(1)
    const newRaw = onChange.mock.calls[0][0] as string
    expect(newRaw).toContain('count: 5')
    expect(newRaw).toContain('title: Hello')
  })

  it('does not fire onChange when the value is unchanged', () => {
    const onChange = vi.fn()
    const el = renderFrontmatter('title: Hello\n', onChange)
    const cell = el.querySelector('.fm-val') as HTMLElement
    cell.dispatchEvent(new Event('blur'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('preserves other keys and comments when editing one value', () => {
    const onChange = vi.fn()
    const raw = 'title: Old # keep me\ncount: 3\n'
    const el = renderFrontmatter(raw, onChange)
    const titleCell = el.querySelector('.fm-val') as HTMLElement
    titleCell.textContent = 'New'
    titleCell.dispatchEvent(new Event('blur'))
    const newRaw = onChange.mock.calls[0][0] as string
    expect(newRaw).toContain('title: New')
    expect(newRaw).toContain('# keep me')
    expect(newRaw).toContain('count: 3')
  })
})

describe('renderFrontmatter — fallback', () => {
  it('falls back to raw <pre> for a malformed kv segment', () => {
    const el = renderFrontmatter('key: "unterminated\n')
    // Malformed YAML in a kv-looking segment → raw fallback somewhere in output.
    expect(el.querySelector('.frontmatter-raw')).toBeTruthy()
  })
})
