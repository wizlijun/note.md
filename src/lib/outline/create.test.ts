// src/lib/outline/create.test.ts
import { describe, it, expect } from 'vitest'
import { newOutlineFileText } from './create'

describe('newOutlineFileText', () => {
  it('produces front-matter (title/created/updated) + one empty bullet', () => {
    const text = newOutlineFileText('我的笔记', '2026-07-10T09:00:00.000Z')
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('title: 我的笔记')
    expect(text).toContain('created: 2026-07-10T09:00:00.000Z')
    expect(text).toContain('updated: 2026-07-10T09:00:00.000Z')
    expect(text.endsWith('---\n- \n') || text.endsWith('---\n-\n')).toBe(true)
  })
  it('newOutlineFileText keeps raw title even when filename would differ', () => {
    const text = newOutlineFileText('a/b 原始标题', '2026-07-10T09:00:00.000Z')
    expect(text).toContain('a/b 原始标题')
  })
})
