import { expect, it } from 'vitest'
import { propose } from './proposal'

const proposal = (base: string, theirs: string, ours = base) => propose({ path: 'a.md', base, ours, theirs })

it('K10 separates title and tags edits with sorted frontmatter keys', () => {
  const base = '---\ntitle: A\ntags: [a]\n---\n甲。'
  const p = proposal(base, base.replace('title: A', 'title: B'), base.replace('tags: [a]', 'tags: [b]'))
  expect(p.hunks.map(h => h.kind)).toEqual(['theirs-only', 'ours-only'])
  expect(p.hunks[0].flags).toEqual(['frontmatter'])
  expect(p.hunks[0].frontmatterKeys).toEqual(['title'])
})

it.each(['type', 'generated', 'verified', 'sources', 'status', 'stale_after'])('K11 marks trust key %s, including insertion and deletion', key => {
  const base = `---\n'${key}': false\n---\n甲。`
  for (const p of [proposal(base, base.replace('false', 'true')), proposal(base, '---\n---\n甲。'), proposal('---\n---\n甲。', base)]) {
    expect(p.hunks[0].flags).toEqual(['trust-field', 'frontmatter'])
    expect(p.hunks[0].frontmatterKeys).toEqual([key])
  }
})

it('keeps normal keys safe and marks degraded frontmatter conservatively', () => {
  expect(proposal('---\nverify: no\n---\n', '---\nverify: yes\n---\n').hunks[0].flags).toEqual(['frontmatter'])
  const p = proposal('---\nnot a key\nverified: false\n---\n甲。', '---\nnot a key\nverified: true\n---\n甲。')
  expect(p.hunks[0].flags).toEqual(['trust-field', 'frontmatter'])
  expect(p.hunks[0].frontmatterKeys).toEqual([])
})

it('deduplicates and orders flags and keys across an entire degraded file', () => {
  const base = '---\nverified: false\nstatus: old\n---\n{>>owner<<}\n'
  const p = proposal(base, base.replace('false', 'true').replace('old', 'new').replace('owner', 'changed') + '\u202E' + '甲。'.repeat(200_001))
  expect(p.hunks[0].flags).toEqual(['trust-field', 'frontmatter', 'owner-annotation', 'hidden-chars', 'degraded'])
  expect(p.hunks[0].frontmatterKeys).toEqual(['status', 'verified'])
})

it.each(['{==选文。==}{>>批注<<}', '{>>点批注<<}'])('marks hunks intersecting a base owner annotation %s', annotation => {
  const base = `前。${annotation}尾。后。`
  expect(proposal(base, base.replace(annotation, '')).hunks[0].flags).toContain('owner-annotation')
  expect(proposal(base, base.replace('批注', '修改')).hunks[0].flags).toContain('owner-annotation')
  const outside = proposal(base, base.replace('前。', '前改。').replace('后。', '后改。'))
  expect(outside.hunks.every(h => !h.flags.includes('owner-annotation'))).toBe(true)
})

it('does not mark newly inserted, escaped, nested or incomplete annotations as owned', () => {
  expect(proposal('甲。', '{>>new<<}甲。').hunks[0].flags).not.toContain('owner-annotation')
  for (const base of ['\\{>>escaped<<}', '{>>outer{>>inner<<}tail<<}', '{==outer{==inner==}{>>comment<<}', '{>>missing', '{++addition++}']) {
    expect(proposal(base, '').hunks[0].flags).not.toContain('owner-annotation')
  }
})

// Bidi controls, zero-width characters and BOM: this explicit set is the
// reviewed kernel policy; ordinary whitespace and variation selectors are excluded.
const hidden = [0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff]
it.each(hidden)('K13 flags newly added U+%s and respects existing multiplicity', code => {
  const c = String.fromCodePoint(code)
  expect(proposal('甲。', `甲${c}。`).hunks[0].flags).toContain('hidden-chars')
  expect(proposal(`甲${c}。`, `乙${c}。`).hunks[0].flags).not.toContain('hidden-chars')
  expect(proposal(`甲${c}。`, `乙${c}${c}。`).hunks[0].flags).toContain('hidden-chars')
  expect(proposal(`甲${c}。`, '甲。').hunks[0].flags).not.toContain('hidden-chars')
})

it('marks only EOL differences between ours and theirs and never rewrites ours', () => {
  for (const ours of ['甲。\r\n', '甲。\r']) {
    const p = proposal('甲。\n', '甲。\n', ours)
    expect(p.hunks[0].flags).toEqual(['eol-only'])
    expect(p.hunks[0].ours).toBe(ours)
  }
  for (const theirs of ['乙。\n', '甲。 \n', '\uFEFF甲。\n', '甲。\uFE0F\n']) {
    expect(proposal('甲。\n', theirs, '甲。\r\n').hunks[0].flags).not.toContain('eol-only')
    expect(proposal('甲。\n', theirs, '甲。\r\n').hunks[0].flags.includes('hidden-chars')).toBe(theirs.includes('\uFEFF'))
  }
})

it('treats point markup nested inside an incomplete highlight as ordinary text', () => {
  const base = '{==incomplete{>>nested point<<}'
  expect(proposal(base, '').hunks[0].flags).not.toContain('owner-annotation')
})
