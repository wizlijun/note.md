import { expect, it } from 'vitest'
import { propose } from './proposal'
import { sha256Sync } from './hash'
import type { MergeProposal } from './types'

const proposal = (base: string, ours: string, theirs: string) => propose({ path: 'a.md', base, ours, theirs })
const reconstruct = (p: MergeProposal) => p.segments.map(s => s.type === 'stable' ? s.text : p.hunks.find(h => h.id === s.id)!.ours).join('')

it('K1 returns no hunks for identical text, including empty and large text', () => {
  for (const text of ['', '\uFEFF甲。\r\n尾', '甲。'.repeat(200_001)]) {
    const p = proposal(text, text, text)
    expect(p.hunks).toEqual([])
    expect(reconstruct(p)).toBe(text)
    expect(p.stats).toEqual({ 'theirs-only': 0, 'ours-only': 0, 'both-same': 0, conflict: 0 })
  }
})

it('K2 isolates the only visitor edit', () => {
  const p = proposal('甲。乙。丙。', '甲。乙。丙。', '甲。乙改。丙。')
  expect(p.hunks).toMatchObject([{ kind: 'theirs-only', base: '乙。', ours: '乙。', theirs: '乙改。', oursStart: 2, oursEnd: 4 }])
  expect(reconstruct(p)).toBe('甲。乙。丙。')
})

it.each([['K3', '甲。乙。丙改。'], ['K4', '甲。乙改。丙。']])('%s keeps separate sentence edits independent', (_, theirs) => {
  const p = proposal('甲。乙。丙。', '甲改。乙。丙。', theirs)
  expect(p.hunks.map(h => h.kind)).toEqual(['ours-only', 'theirs-only'])
  expect(p.stats.conflict).toBe(0)
  expect(reconstruct(p)).toBe('甲改。乙。丙。')
})

it('K5 marks differing edits to the same sentence as a conflict', () => {
  expect(proposal('甲。乙。', '甲一。乙。', '甲二。乙。').hunks).toMatchObject([{ kind: 'conflict', base: '甲。', ours: '甲一。', theirs: '甲二。' }])
})

it('K6 marks identical edits on both sides as both-same', () => {
  expect(proposal('甲。乙。', '甲改。乙。', '甲改。乙。').hunks.map(h => h.kind)).toEqual(['both-same'])
})

it.each([['新增。甲。乙。', '甲改。乙。'], ['甲。新增。乙。', '甲改。乙。']])('K7 merges an insertion at either endpoint into the edited sentence', (ours, theirs) => {
  const p = proposal('甲。乙。', ours, theirs)
  expect(p.hunks.map(h => h.kind)).toEqual(['conflict'])
  expect(reconstruct(p)).toBe(ours)
})

it('K8 treats a fenced code block as atomic', () => {
  const base = '```ts\na\nb\n```\n'
  expect(proposal(base, base.replace('a', 'A'), base.replace('b', 'B')).hunks.map(h => h.kind)).toEqual(['conflict'])
})

it('K9 leaves different table row edits independent', () => {
  const base = '| key | value |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n'
  const p = proposal(base, base.replace('| a | 1', '| a | 3'), base.replace('| b | 2', '| b | 4'))
  expect(p.hunks.map(h => h.kind)).toEqual(['ours-only', 'theirs-only'])
  expect(reconstruct(p)).toBe(base.replace('| a | 1', '| a | 3'))
})

it('K15 is byte-deterministic and keeps visitor IDs through unrelated owner edits', () => {
  const base = '甲。乙。丙。丁。'
  const theirs = '甲。乙改。丙。丁。'
  const p = proposal(base, base, theirs)
  const changed = proposal(base, '甲改。乙。丙。丁改。', theirs)
  expect(JSON.stringify(proposal(base, base, theirs))).toBe(JSON.stringify(p))
  expect(changed.hunks.find(h => h.kind === 'theirs-only')!.id).toBe(p.hunks[0].id)
  expect(p.hunks[0].id).toBe('h_' + sha256Sync('nmk1\0a.md\0乙。\0乙改。\0' + 0).slice(0, 16))
})

it('K15 ordinals count only identical base/theirs pairs', () => {
  const p = proposal('甲。隔。甲。', '甲。隔。甲。', '乙。隔。乙。')
  expect(p.hunks.map(h => h.id)).toEqual([0, 1].map(i => 'h_' + sha256Sync(`nmk1\0a.md\0甲。\0乙。\0${i}`).slice(0, 16)))
})

it('K17 degrades above the token limit on any input, with normal classification', () => {
  const huge = '甲。'.repeat(200_001)
  for (const [base, ours, theirs, kind] of [['', '', huge, 'theirs-only'], ['', huge, '', 'ours-only'], ['', huge, huge, 'both-same'], [huge, '', '乙。', 'conflict']]) {
    const p = proposal(base, ours, theirs)
    expect(p.hunks).toMatchObject([{ base, ours, theirs, kind, flags: ['degraded'], oursStart: 0, oursEnd: ours.length }])
    expect(p.hunks).toHaveLength(1)
    expect(reconstruct(p)).toBe(ours)
  }
})

it('K17 degrades above D=20000 and accepts the exact boundary', () => {
  const boundary = '甲。'.repeat(20_000)
  expect(proposal('', '', boundary).hunks[0].flags).not.toContain('degraded')
  const p = proposal('', '', boundary + '甲。')
  expect(p.hunks).toHaveLength(1)
  expect(p.hunks[0].flags).toEqual(['degraded'])
  expect(p.hunks[0].id).toBe('h_' + sha256Sync(`nmk1\0a.md\0\0${boundary}甲。\0${0}`).slice(0, 16))
})

it('accepts the exact token limit without degrading when D is small', () => {
  const text = '甲。'.repeat(200_000)
  expect(proposal(text, text, '乙。' + text.slice(2)).hunks[0].flags).not.toContain('degraded')
})

it('hashes aligned inputs and preserves owner BOM, CRLF and UTF-16 offsets', () => {
  const base = '\uFEFF甲。\r\n乙。\r\n'
  const ours = '\uFEFF甲。\r\n😀乙。\r\n'
  const p = proposal(base, ours, '甲改。\n乙。\n')
  expect(p.theirsEolAligned).toBe(true)
  expect([p.baseHash, p.oursHash, p.theirsHash]).toEqual([base, ours, '\uFEFF甲改。\r\n乙。\r\n'].map(sha256Sync))
  expect(reconstruct(p)).toBe(ours)
  for (const h of p.hunks) expect(ours.slice(h.oursStart, h.oursEnd)).toBe(h.ours)
})

it.each([['', '', '新增。', 'theirs-only'], ['', '甲。', '乙。', 'conflict'], ['甲。', '', '', 'both-same'], ['甲。乙。', '乙。', '甲。乙。', 'ours-only']])('handles empty input and deletions (%s)', (base, ours, theirs, kind) => {
  const p = proposal(base, ours, theirs)
  expect(p.hunks.map(h => h.kind)).toEqual([kind])
  expect(reconstruct(p)).toBe(ours)
})

it('keeps all four kind counters including zero entries', () => {
  const p = proposal('甲。隔。乙。隔。丙。隔。丁。', '甲改。隔。乙。隔。丙改。隔。丁一。', '甲。隔。乙改。隔。丙改。隔。丁二。')
  expect(p.stats).toEqual({ 'theirs-only': 1, 'ours-only': 1, 'both-same': 1, conflict: 1 })
})

it('reconstructs all three sides and ordered UTF-16 ranges in 500 seeded proposals', () => {
  let seed = 0xa1b2c3d4
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 12) % n }
  const words = ['甲。', '乙。', '丙。', '😀。', '丁！']
  for (let i = 0; i < 500; i++) {
    const sample = () => Array.from({ length: next(25) }, () => words[next(words.length)]).join('')
    const base = sample()
    const ours = sample()
    const theirs = sample()
    const p = proposal(base, ours, theirs)
    for (const [side, expected] of [['base', base], ['ours', ours], ['theirs', theirs]] as const) {
      const result = p.segments.map(s => s.type === 'stable' ? s.text : p.hunks.find(h => h.id === s.id)![side]).join('')
      expect(result).toBe(expected)
    }
    let end = 0
    for (const h of p.hunks) {
      expect(h.oursStart).toBeGreaterThanOrEqual(end)
      expect(ours.slice(h.oursStart, h.oursEnd)).toBe(h.ours)
      end = h.oursEnd
    }
    expect(new Set(p.hunks.map(h => h.id)).size).toBe(p.hunks.length)
  }
})

it('exports the public kernel entry points', async () => {
  const api = await import('./index')
  expect(api.MERGE_KERNEL_VERSION).toBe(1)
  expect(api.propose).toBe(propose)
  expect(api.alignEol('a\r\n', 'b\n')).toEqual({ theirs: 'b\r\n', aligned: true })
  expect(await api.sha256Hex('')).toBe(sha256Sync(''))
})

it('K17 degrades at real Myers D=20001 despite a multiset lower bound of one', () => {
  const a = '甲。'.repeat(10_000)
  const b = '乙。'.repeat(10_000)
  const p = proposal(a + b, a + b, b + '乙。' + a)
  expect(p.hunks).toMatchObject([{ kind: 'theirs-only', base: a + b, ours: a + b, theirs: b + '乙。' + a, flags: ['degraded'] }])
  expect(p.hunks).toHaveLength(1)
}, 20_000)

it('preserves a visitor hunk ID when the owner changes the same sentence', () => {
  const unchanged = proposal('甲。乙。', '甲。乙。', '甲改。乙。')
  const conflict = proposal('甲。乙。', '甲异。乙。', '甲改。乙。')
  const same = proposal('甲。乙。', '甲改。乙。', '甲改。乙。')
  expect([unchanged.hunks[0].kind, conflict.hunks[0].kind, same.hunks[0].kind]).toEqual(['theirs-only', 'conflict', 'both-same'])
  expect([conflict.hunks[0].id, same.hunks[0].id]).toEqual([unchanged.hunks[0].id, unchanged.hunks[0].id])
})
