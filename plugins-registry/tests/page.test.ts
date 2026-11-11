import { describe, expect, it } from 'vitest'
import { PAGE_HTML } from '../src/page'

// Execute the page's own grouping code against old and current index metadata.
function grouping() {
  const script = PAGE_HTML.slice(PAGE_HTML.indexOf('var GROUP_ORDER='), PAGE_HTML.indexOf('function platformForArchs'))
  return new Function(`${script};return {GROUP_ORDER,normalizeGroup,groupPlugins};`)() as {
    GROUP_ORDER: string[]
    normalizeGroup(category: string, id: string): string
    groupPlugins(items: { id: string; category: string }[]): { key: string; items: { id: string; category: string }[] }[]
  }
}

describe('marketplace plugin metadata', () => {
  it('does not advertise the removed OpenClaw plugin', () => {
    expect(PAGE_HTML).not.toMatch(/openclaw/i)
    expect(PAGE_HTML).toContain('notemd.claude-agent')
  })
  it('merges old inspiration metadata into Create without changing the remaining section order', () => {
    const page = grouping()
    expect(page.GROUP_ORDER).toEqual(['ai', 'record', 'reading', 'create', 'advance', 'reflect', 'import-export', 'experience', 'other'])
    for (const id of ['notemd.sumi', 'notemd.idea-spark']) {
      for (const category of ['inspiration', 'experience', 'other', 'create']) {
        expect(page.normalizeGroup(category, id)).toBe('create')
      }
    }
    expect(page.normalizeGroup('inspiration', 'third-party.idea')).toBe('create')
    expect(page.normalizeGroup('unknown', 'third-party.other')).toBe('other')
    const items = [
      { id: 'notemd.sumi', category: 'experience' },
      { id: 'notemd.next', category: 'advance' },
      { id: 'notemd.idea-spark', category: 'inspiration' },
      { id: 'third-party.idea', category: 'inspiration' },
      { id: 'notemd.timeline', category: 'reflect' },
    ]
    expect(page.groupPlugins(items)).toEqual([
      { key: 'create', items: [items[0], items[2], items[3]] },
      { key: 'advance', items: [items[1]] },
      { key: 'reflect', items: [items[4]] },
    ])
  })
  it('shows Create in both plugin entry instructions without retaining a separate Ideas heading', () => {
    expect(PAGE_HTML).not.toContain('group_inspiration:')
    expect(PAGE_HTML).not.toContain('<b>Ideas</b>')
    expect(PAGE_HTML).not.toContain('<b>灵感</b>')
    expect(PAGE_HTML).toContain("'notemd.sumi':{en:'<b>Plugins</b> → <b>Create</b> → Sumi Write'")
    expect(PAGE_HTML).toContain('「<b>插件</b>」→「<b>创作</b>」→ 玄霜写作')
  })
})
