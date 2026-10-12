import { expect, it } from 'vitest'
import { acceptUnconflicted, compose, propose, tokenize } from './index'
import type { HunkDecision } from './types'

const proposal = (base: string, ours: string, theirs: string) => propose({ path: 'a.md', base, ours, theirs })

it('keeps unreviewed changes out and excludes trust fields from bulk acceptance', () => {
  const ours = '---\nverified: false\n---\n甲。'
  const p = proposal(ours, ours, '---\nverified: true\n---\n乙。')
  expect(compose(p, {})).toMatchObject({ text: ours, pendingConflicts: [], pendingTheirs: p.hunks.map(h => h.id), accepted: 0, total: 2, staleDecisions: [] })
  const bulk = acceptUnconflicted(p)
  expect(compose(p, bulk).text).toBe('---\nverified: false\n---\n乙。')
  const trust = p.hunks.find(h => h.flags.includes('trust-field'))!
  expect(trust.id in bulk).toBe(false)
  expect(compose(p, { ...bulk, [trust.id]: { kind: 'theirs-only', choice: 'accept' } }).accepted).toBe(2)
})

it.each(['ours', 'theirs', 'ours+theirs', 'theirs+ours', 'edited'] as const)('composes conflict choice %s exactly', choice => {
  const p = proposal('前。甲。尾。', '前。主人。尾。', '前。访客。尾。')
  const h = p.hunks[0]
  const text = { ours: h.ours, theirs: h.theirs, 'ours+theirs': h.ours + h.theirs, 'theirs+ours': h.theirs + h.ours, edited: '手改\r\n' }[choice]
  expect(compose(p, { [h.id]: { kind: 'conflict', choice, text: '手改\r\n', source: 'human' } })).toEqual({
    text: `前。${text}尾。`, pendingConflicts: [], pendingTheirs: [], accepted: choice === 'ours' ? 0 : 1, total: 1, staleDecisions: [],
  })
})

it('reports pending conflicts and rejects edited decisions without text, allowing empty text', () => {
  const p = proposal('甲。', '主人。', '访客。')
  const id = p.hunks[0].id
  expect(compose(p, {})).toMatchObject({ text: '主人。', pendingConflicts: [id], total: 1, accepted: 0 })
  expect(() => compose(p, { [id]: { kind: 'conflict', choice: 'edited' } })).toThrow(/text/)
  expect(compose(p, { [id]: { kind: 'conflict', choice: 'edited', text: '' } }).text).toBe('')
})

it('invalidates unknown IDs and decisions whose current kind changed', () => {
  const p = proposal('甲。乙。', '甲。乙。', '改。乙。')
  const id = p.hunks[0].id
  const decisions: Record<string, HunkDecision> = { [id]: { kind: 'theirs-only', choice: 'accept' }, missing: { kind: 'theirs-only', choice: 'accept' } }
  const conflict = proposal('甲。乙。', '主人。乙。', '改。乙。')
  expect(compose(conflict, decisions)).toMatchObject({ text: '主人。乙。', pendingConflicts: [id], staleDecisions: [id, 'missing'], accepted: 0 })
  const same = proposal('甲。乙。', '改。乙。', '改。乙。')
  expect(compose(same, decisions)).toMatchObject({ text: '改。乙。', total: 0, accepted: 0, staleDecisions: [id, 'missing'] })
  expect(compose(p, { [id]: { kind: 'conflict', choice: 'theirs' } })).toMatchObject({ text: '甲。乙。', pendingTheirs: [id], staleDecisions: [id] })
})

it('counts only reviewable hunks and preserves segment order', () => {
  const p = proposal('甲。隔。乙。隔。丙。隔。丁。', '主人。隔。乙。隔。同改。隔。丁一。', '甲。隔。客改。隔。同改。隔。丁二。')
  const decisions: Record<string, HunkDecision> = Object.fromEntries(p.hunks.flatMap<[string, HunkDecision]>(h => h.kind === 'theirs-only' ? [[h.id, { kind: h.kind, choice: 'reject' }]] : h.kind === 'conflict' ? [[h.id, { kind: h.kind, choice: 'ours' }]] : []))
  expect(compose(p, decisions)).toMatchObject({ text: '主人。隔。乙。隔。同改。隔。丁一。', total: 2, accepted: 0, pendingConflicts: [], pendingTheirs: [] })
})

it('bulk acceptance excludes all four risks and conflicts while allowing ordinary frontmatter and EOL flags', () => {
  for (const [base, theirs] of [['{>>owner<<}', '{>>changed<<}'], ['甲。', '甲\u202E。'], ['', '甲。'.repeat(200_001)]]) {
    const p = proposal(base, base, theirs)
    expect(acceptUnconflicted(p)).toEqual({})
  }
  expect(acceptUnconflicted(proposal('甲。', '主人。', '客。'))).toEqual({})
  const base = '---\ntitle: A\n---\n'
  const p = proposal(base, base, base.replace('A', 'B'))
  expect(compose(p, acceptUnconflicted(p)).text).toBe(base.replace('A', 'B'))
  const eol = proposal('甲。\n', '甲。\n', '甲。\r')
  expect(compose(eol, acceptUnconflicted(eol)).text).toBe('甲。\r')
})

it('K12 aligns visitor LF to base CRLF while keeping the composed bytes', () => {
  const base = '\uFEFF甲。\r\n乙。\r\n'
  const p = proposal(base, base, '甲。\n乙改。\n')
  expect(p.theirsEolAligned).toBe(true)
  expect(p.hunks).toHaveLength(1)
  expect(compose(p, acceptUnconflicted(p)).text).toBe('\uFEFF甲。\r\n乙改。\r\n')
})

it('K14 preserves token bytes and restores ours after rejecting changes in 500 seeded Markdown cases', () => {
  let seed = 0x1234abcd
  const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n }
  const pieces = ['甲。乙！\n', '# 标题\r\n', '`code;`。', '{==选文==}{>>注<<}', '\n\n', '😀。', '```ts\nx\n```\n', '| a | b |\n| --- | --- |\n', '---\ntitle: A\n---\n']
  for (let i = 0; i < 500; i++) {
    const sample = () => Array.from({ length: next(10) }, () => pieces[next(pieces.length)]).join('')
    const [base, ours, theirs] = [sample(), sample(), sample()]
    for (const text of [base, ours, theirs]) expect(tokenize(text).map(t => t.text).join('')).toBe(text)
    const p = proposal(base, ours, theirs)
    const decisions: Record<string, HunkDecision> = Object.fromEntries(p.hunks.flatMap<[string, HunkDecision]>(h => h.kind === 'theirs-only' ? [[h.id, { kind: h.kind, choice: 'reject' }]] : h.kind === 'conflict' ? [[h.id, { kind: h.kind, choice: 'ours' }]] : []))
    expect(compose(p, decisions).text).toBe(ours)
  }
})

it('K16 avoids accepting the same change twice after a partial writeback', () => {
  const base = '甲。乙。丙。'
  const theirs = '甲改。乙。丙改。'
  const first = proposal(base, base, theirs)
  const accepted = first.hunks[0].id
  const ours = compose(first, { [accepted]: { kind: 'theirs-only', choice: 'accept' } }).text
  const again = proposal(base, ours, theirs)
  expect(again.hunks.map(h => h.kind)).toEqual(['both-same', 'theirs-only'])
  expect(compose(again, acceptUnconflicted(again))).toMatchObject({ text: theirs, accepted: 1, total: 1 })
})
