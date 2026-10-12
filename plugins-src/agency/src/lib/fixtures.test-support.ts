import type { Batch, Episode, Signal } from './types'
export const signal = (state: Signal['state']): Signal => ({ state, note: '以原文为依据。', evidence_indices: state === 'observed' ? [0] : [] })
export const episode = (id = 'episode-1'): Episode => ({
  id, source_id: 'source-1', title: '修正方案后确认结果', goal_origin: 'user', outcome: 'user_confirmed',
  efficacy: signal('observed'), optimism: signal('unknown'), imagination: signal('not_applicable'),
  evidence: [{ line: 159, quote: '解决了。', kind: 'user' }], contribution: ['根据反馈调整方案'], friction: null,
})
export const batchFixture = (): Batch => ({
  id: 'batch-1', date: '2026-09-22', created_at: '2026-09-23T03:00:00Z', provider: 'notemd.codex-agent',
  scan: { date: '2026-09-22', considered: 2, sources: [{ id: 'source-1', path: 'agent-sessions/example.md', sha256: 'hash', title: '示例互动', started: '2026-09-22 08:00', ended: '2026-09-22 09:00', user_turns: 3 }], excluded: [{ path: 'auto-review.md', reason: '自动审批记录' }], warnings: [] },
  episodes: [episode()], skipped_sources: [], suggestion: null, reviews: {},
})
export const practicalEpisode = (id = 'episode-1'): Episode => ({
  ...episode(id),
  evidence: [
    { line: 159, quote: '解决了。', kind: 'user' },
    { line: 143, quote: '实际推流仍然黑屏，需要再修正。', kind: 'user' },
    { line: 170, quote: '以前不能自己调试推流，现在可以用这个脚本完成检查。', kind: 'user' },
  ],
  practical: {
    progress: { note: '画面修复后，用户确认恢复正常。', evidence_indices: [0] },
    friction: { note: '用户发现实际推流异常，额外要求返工。', evidence_indices: [1] },
    expansion: { note: '用户表示从无法自行调试，到能使用脚本检查推流。', evidence_indices: [2] },
    experiment: { action: '下一次发布前，用该脚本自行检查推流。', check: '记录能否在请求 AI 协助前发现异常。', evidence_indices: [2] },
  },
})
export const practicalBatchFixture = (): Batch => ({ ...batchFixture(), rule_version: 2, episodes: [practicalEpisode()] })
