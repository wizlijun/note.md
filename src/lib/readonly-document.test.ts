import { describe, expect, it } from 'vitest'
import { hasReadonlyFrontmatter, isReadonlyMarkdownTab } from './readonly-document'

describe('readonly YAML metadata', () => {
  it.each([
    '---\nreadonly: true\n---\n# Note',
    '\uFEFF---\r\nreadonly: true # mirror\r\n---\r\nNote',
    '---\n"readonly": TRUE\n---',
  ])('recognizes a leading YAML boolean', (content) => {
    expect(hasReadonlyFrontmatter(content)).toBe(true)
  })

  it.each([
    '---\nreadonly: false\n---',
    '---\nreadonly: "true"\n---',
    '---\nreadonly: 1\n---',
    '---\nmetadata:\n  readonly: true\n---',
    '# Note\n---\nreadonly: true\n---',
    '---\nreadonly: true',
    '---\nreadonly: true\nreadonly: false\n---',
    '---\nreadonly: [true\n---',
  ])('does not lock documents without valid boolean metadata', (content) => {
    expect(hasReadonlyFrontmatter(content)).toBe(false)
  })

  it('applies only to Markdown and the accepted disk snapshot', () => {
    const content = '---\nreadonly: true\n---'
    expect(isReadonlyMarkdownTab({ kind: 'code', initialContent: content })).toBe(false)
    expect(isReadonlyMarkdownTab({ kind: 'markdown', initialContent: content })).toBe(true)
  })
})
