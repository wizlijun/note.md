import { expect, it, vi } from 'vitest'
import { propose, MERGE_KERNEL_VERSION } from '../share-merge'
import { prepareGitReview, gitTarget, pushCommand } from './git'
import type { LocalFeedback } from './types'

function fixture() {
  const files = [
    { path: 'a.md', base: '甲。乙。', current: '甲改。乙。', after: '甲。乙改。' },
    { path: 'b.md', base: 'B。', current: 'B。', after: 'B改。' },
  ]
  const feedback = { envelope: { payload: { submissionId: 's', edits: files.map(f => ({ path: f.path, afterMarkdown: f.after })) } }, decisions: {}, review: {} } as unknown as LocalFeedback
  for (const file of files) {
    const p = propose({ path: file.path, base: file.base, ours: file.base, theirs: file.after })
    feedback.review![file.path] = { kernel_version: MERGE_KERNEL_VERSION, ours_hash: 'workspace', target: 'worktree', updated_at: '', hunks: Object.fromEntries(p.hunks.map(h => [h.id, { kind: h.kind, choice: 'accept' }])) }
  }
  const prepared = { head: 'fixed-H', entry: 'a.md', feedback, files, commitMessage: 'trusted' }
  return { prepared, feedback, files, command: vi.fn(async () => prepared) as any, compute: vi.fn(async input => propose(input)) }
}
it('uses the remote default and authoritative project target', () => {
  expect(gitTarget({ git: true, team: true, prefix: '', remote: 'upstream' })).toBe('branch')
  expect(gitTarget({ git: true, team: false, prefix: '' })).toBe('worktree')
  expect(gitTarget({ git: true, team: true, prefix: '', target: 'patch' })).toBe('patch')
  expect(gitTarget({ git: false, team: false, prefix: '', target: 'patch' })).toBe('worktree')
})
it('reuses decisions with the real kernel on two files at one fixed HEAD', async () => {
  const h = fixture(), result = await prepareGitReview('p', 's', h)
  expect(result.results).toEqual({ 'a.md': '甲改。乙改。', 'b.md': 'B改。' })
  expect(result.prepared.head).toBe('fixed-H')
  expect(h.command).toHaveBeenCalledExactlyOnceWith('prepare', { project_id: 'p', submissionId: 's' })
})
it.each(['version', 'unknown', 'kind', 'conflict', 'missing'] as const)('blocks the entire result on %s', async kind => {
  const h = fixture()
  if (kind === 'version') h.feedback.review!['b.md'].kernel_version++
  if (kind === 'unknown') h.feedback.review!['b.md'].hunks.old = { kind: 'theirs-only', choice: 'accept' }
  if (kind === 'kind') Object.values(h.feedback.review!['b.md'].hunks).forEach((d: any) => d.kind = 'conflict')
  if (kind === 'conflict') { h.files[1].current = '冲突。'; h.feedback.review!['b.md'].hunks = {} }
  if (kind === 'missing') h.command.mockRejectedValue(new Error('missing HEAD blob'))
  await expect(prepareGitReview('p', 's', h)).rejects.toThrow()
  expect(h.command.mock.calls.every(([op]: [string]) => op === 'prepare')).toBe(true)
})
it('shows pending theirs without accepting them and requires some reviewed acceptance', async () => {
  const h = fixture(); delete h.feedback.review!['b.md']
  const result = await prepareGitReview('p', 's', h)
  expect(result.files[1]).toMatchObject({ result: 'B。', pendingTheirs: 1 })
  delete h.feedback.review!['a.md']
  await expect(prepareGitReview('p', 's', h)).rejects.toThrow('先审阅')
})
it('quotes remote and branch as shell literals, with an option terminator', () => {
  expect(pushCommand("team's repo", 'share/topic')).toBe("git push -- 'team'\"'\"'s repo' 'share/topic'")
})
