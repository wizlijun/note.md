import { describe, expect, it } from 'vitest'
import { emptyCounters, type DeviceAnalytics } from '../insights/model'
import {
  activityFor, applyAttention, applyEdit, contentKey, contentLists, discoverContent,
  dismissContent, migrateOwnerHistory, normalizeHomeContent,
  type ContentCandidate, type VaultContent,
} from './model'

const ROOT = '/fixture/vault'
const NOW = Date.UTC(2026, 10, 19, 8)
const DAY = 86_400_000
const vault = (): VaultContent => ({ initializedAt: 0, migrated: false, docs: {} })
const candidate = (name: string, createdAt: number | null = NOW - DAY, patch: Partial<ContentCandidate> = {}): ContentCandidate => ({
  path: ROOT + '/' + name, title: null, conceptType: null, createdAt, modifiedAt: NOW, ...patch,
})
const paths = (items: { path: string }[]) => items.map(item => item.path)

function history(path: string, readMs: number, sourceMs = 0): DeviceAnalytics {
  return {
    deviceId: 'fixture-device', deviceName: 'Fixture',
    docs: { [contentKey(path, ROOT)]: { '2026-11-18': { ...emptyCounters(NOW - DAY), read_ms: readMs, edit_ms: sourceMs } } },
    sessions: { [contentKey(path, ROOT)]: { '2026-11-18': [{ start: NOW - DAY, end: NOW - DAY + readMs + sourceMs, read_ms: readMs, edit_ms: sourceMs }] } },
  }
}

describe('home content selection', () => {
  it('passes catalog body previews to either list without storing them in activity records', () => {
    const state = vault(), fresh = candidate('report.md', NOW - 1000, { preview: '  A real paragraph from the report.  ' })
    const reading = candidate('reading.md', NOW - 2000, { preview: 'Another real paragraph.' })
    discoverContent(state, [fresh, reading], ROOT, NOW)
    applyEdit(activityFor(state, reading.path, ROOT, NOW), NOW)
    const lists = contentLists(state, [fresh, reading], ROOT, NOW)
    expect(lists.newItems[0].preview).toBe('A real paragraph from the report.')
    expect(lists.continueItems[0].preview).toBe('Another real paragraph.')
    expect(JSON.stringify(state)).not.toContain('preview')
  })

  it.each([undefined, null])('retains missing/null wire previews and external entries without inventing text: %s', preview => {
    const state = vault(), legacy = candidate('legacy.md', undefined, { preview })
    const external = '/outside/reading.pdf'
    discoverContent(state, [legacy], ROOT, NOW)
    applyEdit(activityFor(state, external, ROOT, NOW), NOW)
    const lists = contentLists(state, [legacy], ROOT, NOW)
    expect(lists.newItems[0]).not.toHaveProperty('preview')
    expect(lists.continueItems[0]).toMatchObject({ path: external, detail: '/outside' })
    expect(lists.continueItems[0]).not.toHaveProperty('preview')
  })

  it('fills ten entries after excluding newer automation noise, while retaining agent reports and ordinary unknown types', () => {
    const state = vault()
    const noise = [
      ...Array.from({ length: 12 }, (_, n) => candidate(`skills/${n}.md`, NOW)),
      candidate('AGENTS.md', NOW), candidate('log.md', NOW),
      candidate('indexes/topics.md', NOW, { conceptType: 'Book Topic Index' }),
    ]
    const content = Array.from({ length: 12 }, (_, n) => candidate(`reports/${n}.md`, NOW - n - 1, { conceptType: n === 0 ? 'Answer' : 'Unrecognized body' }))
    const all = [...noise, ...content]
    discoverContent(state, all, ROOT, NOW)
    expect(paths(contentLists(state, all, ROOT, NOW).newItems)).toEqual(content.slice(0, 10).map(c => c.path))
  })

  it('orders by creation/discovery rather than automation modification time', () => {
    const state = vault()
    const older = candidate('older.md', NOW - 2 * DAY, { modifiedAt: NOW + DAY })
    const newer = candidate('newer.md', NOW - DAY, { modifiedAt: NOW - DAY })
    discoverContent(state, [older, newer], ROOT, NOW)
    older.modifiedAt += DAY
    discoverContent(state, [older, newer], ROOT, NOW + DAY)
    expect(paths(contentLists(state, [older, newer], ROOT, NOW + DAY).newItems)).toEqual([newer.path, older.path])
  })

  it('does not fabricate initial freshness for unknown or old files, even if briefly visited before scanning', () => {
    const state = vault()
    const old = candidate('old.md', NOW - 31 * DAY)
    const unknown = candidate('unknown.md', null)
    const recent = candidate('recent.md')
    for (const c of [old, unknown]) applyAttention(activityFor(state, c.path, ROOT, NOW), 5_000, 5_000, NOW)
    discoverContent(state, [old, unknown, recent], ROOT, NOW)
    expect(paths(contentLists(state, [old, unknown, recent], ROOT, NOW).newItems)).toEqual([recent.path])
    const imported = candidate('later-import.md', NOW - 365 * DAY)
    discoverContent(state, [old, unknown, recent, imported], ROOT, NOW + DAY)
    expect(paths(contentLists(state, [old, unknown, recent, imported], ROOT, NOW + DAY).newItems)).toEqual([imported.path, recent.path])
  })

  it('marks read at 30 seconds and qualifies continuation at 60 seconds of the current visit', () => {
    const state = vault(), c = candidate('reading.md')
    discoverContent(state, [c], ROOT, NOW)
    const doc = activityFor(state, c.path, ROOT, NOW)
    applyAttention(doc, 29_999, 29_999, NOW + 29_999)
    expect(contentLists(state, [c], ROOT, NOW + 29_999).newItems).toHaveLength(1)
    applyAttention(doc, 30_000, 30_000, NOW + 30_000)
    expect(contentLists(state, [c], ROOT, NOW + 30_000)).toMatchObject({ newItems: [], continueItems: [] })
    applyAttention(doc, 59_999, 59_999, NOW + 59_999)
    expect(contentLists(state, [c], ROOT, NOW + 59_999).continueItems).toHaveLength(0)
    applyAttention(doc, 60_000, 60_000, NOW + 60_000)
    expect(paths(contentLists(state, [c], ROOT, NOW + 60_000).continueItems)).toEqual([c.path])
  })

  it('makes a real edit read and resumable immediately without duplicating the two lists', () => {
    const state = vault(), c = candidate('editing.md')
    discoverContent(state, [c], ROOT, NOW)
    applyEdit(activityFor(state, c.path, ROOT, NOW), NOW + 1)
    const lists = contentLists(state, [c], ROOT, NOW + 1)
    expect(lists.newItems).toEqual([])
    expect(paths(lists.continueItems)).toEqual([c.path])
  })

  it('does not let a short later preview bump an already qualified document', () => {
    const state = vault(), a = candidate('a.md'), b = candidate('b.md')
    discoverContent(state, [a, b], ROOT, NOW)
    const first = activityFor(state, a.path, ROOT, NOW)
    applyAttention(first, 60_000, 60_000, NOW + 60_000)
    applyEdit(activityFor(state, b.path, ROOT, NOW), NOW + 70_000)
    applyAttention(first, 65_000, 5_000, NOW + 100_000)
    expect(paths(contentLists(state, [a, b], ROOT, NOW + 100_000).continueItems)).toEqual([b.path, a.path])
  })

  it('migrates source-mode attention once as reading, without inventing a real edit or reviving a dismissal', () => {
    const state = vault(), c = candidate('source.md')
    discoverContent(state, [c], ROOT, NOW)
    const doc = activityFor(state, c.path, ROOT, NOW)
    dismissContent(doc, 'continue', NOW)
    const devices = [history(c.path, 0, 60_000)]
    migrateOwnerHistory(state, devices, ROOT)
    migrateOwnerHistory(state, devices, ROOT)
    expect(doc.readMs).toBe(60_000)
    expect(doc.readAt).toBeGreaterThan(0)
    expect(doc.lastEditedAt).toBe(0)
    expect(contentLists(state, [c], ROOT, NOW).continueItems).toEqual([])
    expect(contentLists(state, [c], ROOT, NOW).newItems).toEqual([])
  })

  it('persists independent dismissals across restart and requires new qualifying activity to return', () => {
    const state = vault(), fresh = candidate('fresh.md'), reading = candidate('reading.md')
    discoverContent(state, [fresh, reading], ROOT, NOW)
    dismissContent(activityFor(state, fresh.path, ROOT, NOW), 'new', NOW + 1)
    const active = activityFor(state, reading.path, ROOT, NOW)
    applyAttention(active, 60_000, 60_000, NOW + 60_000)
    dismissContent(active, 'continue', NOW + 70_000)
    const restored = normalizeHomeContent(JSON.parse(JSON.stringify({ version: 1, vaults: { [ROOT]: state } }))).vaults[ROOT]
    fresh.modifiedAt = NOW + DAY
    discoverContent(restored, [fresh, reading], ROOT, NOW + DAY)
    expect(contentLists(restored, [fresh, reading], ROOT, NOW + DAY)).toMatchObject({ newItems: [], continueItems: [] })
    const doc = activityFor(restored, reading.path, ROOT, NOW)
    applyAttention(doc, 119_999, 59_999, NOW + DAY + 59_999)
    expect(contentLists(restored, [fresh, reading], ROOT, NOW + DAY + 59_999).continueItems).toEqual([])
    applyAttention(doc, 120_000, 60_000, NOW + DAY + 60_000)
    expect(paths(contentLists(restored, [fresh, reading], ROOT, NOW + DAY + 60_000).continueItems)).toEqual([reading.path])
  })

  it('filters unavailable external files before limiting while preserving their activity for recovery', () => {
    const state = vault()
    state.initializedAt = NOW
    const missing = Array.from({ length: 12 }, (_, n) => `/offline/${n}.md`)
    const present = Array.from({ length: 10 }, (_, n) => `/external/${n}.md`)
    for (const [n, path] of [...missing, ...present].entries()) applyEdit(activityFor(state, path, ROOT, NOW), NOW - n)
    const hidden = contentLists(state, [], ROOT, NOW, 10, new Set(missing))
    expect(paths(hidden.continueItems)).toEqual(present)
    expect(paths(contentLists(state, [], ROOT, NOW).continueItems)).toEqual(missing.slice(0, 10))
  })
})
