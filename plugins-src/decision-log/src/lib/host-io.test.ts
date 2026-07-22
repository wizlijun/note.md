import { describe, it, expect, vi, beforeEach } from 'vitest'

const fs = new Map<string, string>()
vi.mock('./bridge', () => ({
  vaultExists: (path: string) => Promise.resolve({ exists: fs.has(path) }),
  vaultRead: (path: string) => Promise.resolve({ content: fs.get(path) ?? '' }),
  vaultWrite: (path: string, content: string) => { fs.set(path, content); return Promise.resolve({ ok: true }) },
  vaultList: () => Promise.resolve({ entries: [] }),
}))

import { consumeDiaryItem, appendRejected } from './host-io'

const diary = 'diary/2026-07-21-decision.json'
const rejected = 'decision/_rejected.json'

beforeEach(() => { fs.clear() })

describe('consumeDiaryItem', () => {
  it('marks the matched item and writes back', async () => {
    fs.set(diary, JSON.stringify({
      date: '2026-07-21', new_candidates: [], closures: [],
      edit_decisions: [{ decision_id: 'e1', kind: 'progress', summary: 's', suggested_action: 'note', status: 'pending' }],
    }))
    await consumeDiaryItem('2026-07-21', 'edit_decisions', 'e1', 'accepted')
    expect(JSON.parse(fs.get(diary)!).edit_decisions[0].status).toBe('accepted')
  })
  it('no-op when file does not exist', async () => {
    await consumeDiaryItem('2099-01-01', 'closures', 'x', 'dismissed')
    expect(fs.size).toBe(0)
  })
  it('does not write when nothing matched', async () => {
    const original = JSON.stringify({ date: 'd', new_candidates: [], closures: [], edit_decisions: [] })
    fs.set(diary, original)
    await consumeDiaryItem('2026-07-21', 'closures', 'zzz', 'accepted')
    expect(fs.get(diary)).toBe(original)
  })
})

describe('appendRejected', () => {
  it('creates decision/_rejected.json when missing', async () => {
    await appendRejected({ type: 'candidate', title: 'A', rejected_at: '2026-07-22' })
    const out = JSON.parse(fs.get(rejected)!)
    expect(out.rejected).toEqual([{ type: 'candidate', title: 'A', rejected_at: '2026-07-22' }])
  })
  it('merges onto an existing file', async () => {
    fs.set(rejected, JSON.stringify({ rejected: [{ type: 'closure', decision_id: 'x', rejected_at: '2026-07-20' }] }))
    await appendRejected({ type: 'edit', decision_id: 'e', kind: 'progress', summary: 's', rejected_at: '2026-07-22' })
    const out = JSON.parse(fs.get(rejected)!)
    expect(out.rejected).toHaveLength(2)
    expect(out.rejected[1].decision_id).toBe('e')
  })
})
