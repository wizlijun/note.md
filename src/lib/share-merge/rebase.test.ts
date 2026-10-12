import { expect, it } from 'vitest'
import { rebaseDraft } from './index'

it('rebases independent owner and guest edits onto the new base', () => {
  const result = rebaseDraft({ path: 'a.md', oldBase: '甲。乙。丙。', newBase: '甲改。乙。丙。', draft: '甲。乙。丙改。' })
  expect(result.text).toBe('甲改。乙。丙改。')
  expect(result.conflicts).toEqual([])
  expect(result.proposal.path).toBe('a.md')
  expect(result.ownerAnnotationTouched).toBe(false)
})

it('leaves conflicts pending instead of automatically deciding either side', () => {
  const result = rebaseDraft({ path: 'a.md', oldBase: '原文。', newBase: '主人。', draft: '访客。' })
  expect(result.text).toBe('主人。')
  expect(result.conflicts).toEqual([result.proposal.hunks[0].id])
  expect(result.proposal.hunks[0].kind).toBe('conflict')
})

it('accepts guest-only edits even when risk flags require owner-side review', () => {
  const base = '---\nverified: false\n---\n{>>主人注<<}甲。'
  const result = rebaseDraft({ path: 'a.md', oldBase: base, newBase: base, draft: '---\nverified: true\n---\n{>>修改<<}甲\u202E。' })
  expect(result.text).toBe('---\nverified: true\n---\n{>>修改<<}甲\u202E。')
  expect(result.conflicts).toEqual([])
  expect(result.ownerAnnotationTouched).toBe(true)
})
