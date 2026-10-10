import { describe, expect, it } from 'vitest'
import { defaultShareTitle, normalizeShareTitle } from './title'

describe('project share title', () => {
  it.each(['md', 'MD', 'markdown', 'mdown', 'mkd', 'mdx'])('uses the entry basename without .%s', extension => {
    expect(defaultShareTitle(`docs/Strategy.${extension}`)).toBe('Strategy')
  })
  it('preserves other extensions and falls back for missing names', () => {
    expect(defaultShareTitle('docs/report.txt')).toBe('report.txt')
    expect(defaultShareTitle('docs/.md')).toBe('未命名文档')
    expect(defaultShareTitle('')).toBe('未命名文档')
    expect(defaultShareTitle('docs/')).toBe('未命名文档')
  })
  it('trims user input and uses only the entry for an empty value', () => {
    expect(normalizeShareTitle('  自定义 <标题>  ', 'docs/start.md')).toBe('自定义 <标题>')
    expect(normalizeShareTitle('  ', 'docs/start.md')).toBe('start')
    expect(normalizeShareTitle(undefined, 'docs/start.MDX')).toBe('start')
  })
})
