import { expect, it } from 'vitest'
import { buildGuestSubmission, type SubmissionInput } from './guest-submission'
import { sha256Sync } from '../share-merge/hash'
import { anchor, sha256Hex } from '../share-merge'
const make = (base: string, raw = base): SubmissionInput => ({ project_id: 'P', submissionId: 'I', client: { kind: 'browser', version: 'test-version' }, draft: { v: 2, lineageId: 'L', snapshotId: 'S1', base: { 'a.md': { hash: sha256Sync(base), markdown: base } }, after: { 'a.md': raw }, annotationKinds: {} } })
it('uses actual extraction/anchor and preserves owner BOM/CRLF bytes', () => {
  const base = '\uFEFF{==主人==}{>>保留<<}\r\n\r\n风险。\r\n'
  const raw = '\uFEFF{==主人==}{>>保留<<}\r\n\r\n{==风险==}{>>请量化<<}！\r\n'
  const result = buildGuestSubmission(make(base, raw)), payload = JSON.parse(result.body)
  expect(payload.edits?.[0]?.afterMarkdown).toBe('\uFEFF{==主人==}{>>保留<<}\r\n\r\n风险！\r\n')
  expect(anchor(payload.edits[0].afterMarkdown, payload.annotations[0].selector).status).toBe('exact')
  expect(result.body).not.toContain('ownerAnnotationsTouched')
  expect(result.summary).toEqual({ files: 1, blocks: 1, annotations: 1 })
})
it('browser and desktop produce the same deterministic payload except client', () => {
  const input = make('a', 'b'), browser = JSON.parse(buildGuestSubmission(input).body)
  const desktop = JSON.parse(buildGuestSubmission({ ...input, client: { ...input.client, kind: 'notemd' } }).body)
  expect(browser.client?.kind).toBe('browser'); delete browser.client; delete desktop.client; expect(desktop).toEqual(browser)
  expect(buildGuestSubmission(input)).toEqual(buildGuestSubmission(input))
})
it('no edits for unchanged or annotation-only; point and duplicate owner are guests', () => {
  expect(JSON.parse(buildGuestSubmission(make('a')).body).edits).toEqual([])
  const only = JSON.parse(buildGuestSubmission(make('a', '{==a==}{>>why<<}')).body)
  expect(only.edits).toEqual([]); expect(only.annotations).toHaveLength(1)
  const point = JSON.parse(buildGuestSubmission(make('a', 'a{>>point<<}')).body)
  expect(point.annotations[0].selector.exact).toBe('')
  const O = '{==a==}{>>owner<<}'
  const repeated = JSON.parse(buildGuestSubmission(make(O, O + O)).body)
  expect(repeated.annotations).toHaveLength(1)
})
it('uses kind hash, forwards lineage metadata and reports touched owners only locally', () => {
  const input = make('{==a==}{>>old<<}', '{==a==}{>>new<<}')
  input.draft.annotationKinds[sha256Sync('a\0new').slice(0, 16)] = 'blocker'
  input.draft.lastSubmissionId = 'previous'; input.draft.rebasedFrom = 'old-snapshot'
  const r = buildGuestSubmission(input), p = JSON.parse(r.body)
  expect(p.annotations?.[0]?.kind).toBe('blocker'); expect(p.supersedes).toBe('previous'); expect(p.rebasedFrom).toBe('old-snapshot')
  expect(r.ownerAnnotationsTouched).toEqual([{ path: 'a.md', raw: ['{==a==}{>>old<<}'] }])
})
it.each([{ message: 'a'.repeat(2001) }, { message: '\0' }, { name: 'a'.repeat(81) }, { name: '\n' }])('rejects invalid fields %j', extra => {
  expect(() => buildGuestSubmission({ ...make('a'), ...extra })).toThrow()
})
it('rejects a non-base path', () => {
  const input = make('a'); input.draft.after['b.md'] = 'x'; expect(() => buildGuestSubmission(input)).toThrow()
})
it('enforces the exact UTF8 5 MiB boundary', () => {
  const input = make('', 'x'), first = buildGuestSubmission(input)
  const size = 5 * 1024 * 1024 - new TextEncoder().encode(first.body).length + 1
  input.draft.after['a.md'] = 'x'.repeat(size)
  expect(new TextEncoder().encode(buildGuestSubmission(input).body).length).toBe(5 * 1024 * 1024)
  input.draft.after['a.md'] += 'x'; expect(() => buildGuestSubmission(input)).toThrow()
})

it('uses the same hash as the public async API', async () => { expect(sha256Sync('原文\r\n')).toBe(await sha256Hex('原文\r\n')) })
