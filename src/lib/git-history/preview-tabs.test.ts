import { describe, it, expect } from 'vitest'
import { upsertTab, type PreviewTab } from './preview-tabs'

const t = (id: string, content = id): PreviewTab => ({ id, title: id, kind: 'diff', content })

describe('upsertTab', () => {
  it('appends a new tab and activates it', () => {
    const r = upsertTab([t('a')], t('b'))
    expect(r.tabs.map((x) => x.id)).toEqual(['a', 'b'])
    expect(r.activeId).toBe('b')
  })
  it('updates an existing tab in place and activates it (no duplicate)', () => {
    const r = upsertTab([t('a'), t('b', 'old')], t('b', 'new'))
    expect(r.tabs.map((x) => x.id)).toEqual(['a', 'b'])
    expect(r.tabs[1].content).toBe('new')
    expect(r.activeId).toBe('b')
  })
  it('does not mutate the input array', () => {
    const input = [t('a')]
    upsertTab(input, t('b'))
    expect(input.map((x) => x.id)).toEqual(['a'])
  })
})
