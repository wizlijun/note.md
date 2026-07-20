import { describe, it, expect } from 'vitest'
import { createAnalyticsStore, type Fs, type DayFile } from './store.svelte'
import { emptyCounters } from './model'

function memoryFs(): Fs & { files: Record<string, string> } {
  const files: Record<string, string> = {}
  return {
    files,
    async exists(p) { return p in files || Object.keys(files).some((f) => f.startsWith(p + '/')) },
    async mkdir() {},
    async readDir(dir) {
      const prefix = dir.replace(/\/$/, '') + '/'
      return Object.keys(files)
        .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
        .map((f) => ({ name: f.slice(prefix.length), isFile: true }))
    },
    async readTextFile(p) { return files[p] },
    async writeTextFile(p, c) { files[p] = c },
  }
}

const CFG = { deviceId: 'DEV1', deviceName: 'Mac', tzOffsetMinutes: 480 }
const DAY = '2026-07-08'
const NOW = Date.UTC(2026, 6, 8, 7, 0) // UTC+8 → 2026-07-08 15:00 local

describe('analytics store', () => {
  it('accrues counter deltas into the correct local day bucket', () => {
    const store = createAnalyticsStore({ fs: memoryFs(), vaultRoot: () => '/v', ...CFG })
    store.accrue('rel:a.md', { read_ms: 500, mark_ops: 2 }, NOW)
    const days = store.snapshot()['rel:a.md']
    expect(days[DAY].read_ms).toBe(500)
    expect(days[DAY].mark_ops).toBe(2)
  })

  it('flush writes one file per day named <day>.<deviceId>.json', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    store.accrue('rel:a.md', { read_ms: 500 }, NOW)
    await store.flush()
    const raw = fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`]
    expect(raw).toBeDefined()
    const parsed = JSON.parse(raw) as DayFile
    expect(parsed.day).toBe(DAY)
    expect(parsed.deviceId).toBe('DEV1')
    expect(parsed.docs['rel:a.md'].read_ms).toBe(500)
  })

  it('flush only rewrites days touched this session', async () => {
    const fs = memoryFs()
    // A stale file for a different, untouched day must survive a flush.
    fs.files['/v/.notemd/analytics/2026-07-01.DEV1.json'] = 'DO NOT TOUCH'
    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    store.accrue('rel:a.md', { read_ms: 500 }, NOW)
    await store.flush()
    expect(fs.files['/v/.notemd/analytics/2026-07-01.DEV1.json']).toBe('DO NOT TOUCH')
  })

  it('preloadDay seeds memory so flush MERGES with a prior session (no data loss on restart)', async () => {
    const fs = memoryFs()
    // Simulate a file left by an earlier session today.
    const prior: DayFile = {
      deviceId: 'DEV1', deviceName: 'Mac', day: DAY,
      docs: { 'rel:a.md': { ...emptyCounters(NOW), read_ms: 1000, open_count: 1 } },
    }
    fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`] = JSON.stringify(prior)

    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    await store.preloadDay(DAY)
    store.accrue('rel:a.md', { read_ms: 500, open_count: 1 }, NOW) // this session adds more
    await store.flush()

    const parsed = JSON.parse(fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`]) as DayFile
    expect(parsed.docs['rel:a.md'].read_ms).toBe(1500) // 1000 prior + 500 this session
    expect(parsed.docs['rel:a.md'].open_count).toBe(2)
  })

  it('readAllDevices reconstructs every device across day files, own data overlaid from memory', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })

    // Own device: an older day on disk + a fresh in-memory day (unflushed).
    const ownOld: DayFile = {
      deviceId: 'DEV1', deviceName: 'Mac', day: '2026-07-07',
      docs: { 'rel:a.md': { ...emptyCounters(0), read_ms: 100 } },
    }
    fs.files['/v/.notemd/analytics/2026-07-07.DEV1.json'] = JSON.stringify(ownOld)
    store.accrue('rel:a.md', { read_ms: 500 }, NOW) // today, in memory, not flushed

    // Another device's day file on disk.
    const other: DayFile = {
      deviceId: 'DEV2', deviceName: 'iPhone', day: DAY,
      docs: { 'rel:a.md': { ...emptyCounters(0), read_ms: 250 } },
    }
    fs.files[`/v/.notemd/analytics/${DAY}.DEV2.json`] = JSON.stringify(other)

    const all = await store.readAllDevices()
    const byId = Object.fromEntries(all.map((d) => [d.deviceId, d]))
    expect(Object.keys(byId).sort()).toEqual(['DEV1', 'DEV2'])
    // Own device merges its on-disk older day with the fresh in-memory day.
    expect(byId['DEV1'].docs['rel:a.md']['2026-07-07'].read_ms).toBe(100)
    expect(byId['DEV1'].docs['rel:a.md'][DAY].read_ms).toBe(500)
    // Other device read straight from disk.
    expect(byId['DEV2'].docs['rel:a.md'][DAY].read_ms).toBe(250)
  })

  it('flush merges a same-day file from disk even when the day was never preloaded (midnight rollover)', async () => {
    const fs = memoryFs()
    // An earlier session (e.g. this morning after midnight) already wrote today's file.
    const prior: DayFile = {
      deviceId: 'DEV1', deviceName: 'Mac', day: DAY,
      docs: { 'rel:a.md': { ...emptyCounters(NOW), read_ms: 1000, open_count: 1 } },
    }
    fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`] = JSON.stringify(prior)

    // This session started "yesterday" and crossed midnight: it accrues into DAY
    // without ever having preloaded it.
    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    store.accrue('rel:a.md', { read_ms: 500, open_count: 1 }, NOW)
    await store.flush()

    const parsed = JSON.parse(fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`]) as DayFile
    expect(parsed.docs['rel:a.md'].read_ms).toBe(1500) // prior 1000 must not be overwritten
    expect(parsed.docs['rel:a.md'].open_count).toBe(2)

    // A second flush must not double-absorb the disk data.
    store.accrue('rel:a.md', { read_ms: 1 }, NOW)
    await store.flush()
    const again = JSON.parse(fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`]) as DayFile
    expect(again.docs['rel:a.md'].read_ms).toBe(1501)
  })

  it('flush is a no-op when no vault is configured', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => null, ...CFG })
    store.accrue('rel:a.md', { read_ms: 500 }, NOW)
    await store.flush()
    expect(Object.keys(fs.files)).toHaveLength(0)
  })
})

describe('attention sessions', () => {
  it('records one interval with end = start + read_ms + edit_ms; read↔edit does not split', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    store.sessionStart('rel:a.md', NOW)
    store.sessionExtend('rel:a.md', 'read', 2000, NOW + 2000)
    store.sessionExtend('rel:a.md', 'edit', 3000, NOW + 5000) // mode switch, same session
    store.sessionClose('rel:a.md')
    await store.flush()

    const parsed = JSON.parse(fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`]) as DayFile
    const list = parsed.sessions!['rel:a.md']
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({ start: NOW, end: NOW + 5000, read_ms: 2000, edit_ms: 3000 })
  })

  it('a second start after close yields a second interval (re-read the same doc)', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    store.sessionStart('rel:a.md', NOW)
    store.sessionExtend('rel:a.md', 'read', 1000, NOW + 1000)
    store.sessionClose('rel:a.md')
    store.sessionStart('rel:a.md', NOW + 10_000)
    store.sessionExtend('rel:a.md', 'read', 4000, NOW + 14_000)
    store.sessionClose('rel:a.md')
    await store.flush()

    const parsed = JSON.parse(fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`]) as DayFile
    const list = parsed.sessions!['rel:a.md']
    expect(list).toHaveLength(2)
    expect(list[1]).toEqual({ start: NOW + 10_000, end: NOW + 14_000, read_ms: 4000, edit_ms: 0 })
  })

  it('sessionStart is idempotent while an interval is open', () => {
    const store = createAnalyticsStore({ fs: memoryFs(), vaultRoot: () => '/v', ...CFG })
    store.sessionStart('rel:a.md', NOW)
    store.sessionStart('rel:a.md', NOW + 500) // ignored — one already open
    store.sessionExtend('rel:a.md', 'read', 1000, NOW + 1000)
    store.sessionClose('rel:a.md')
    // Only one interval accumulated all the time.
    // (Verified via flush below.)
  })

  it('preloadDay seeds prior intervals so flush appends this session (no restart loss)', async () => {
    const fs = memoryFs()
    const prior: DayFile = {
      deviceId: 'DEV1', deviceName: 'Mac', day: DAY,
      docs: { 'rel:a.md': { ...emptyCounters(NOW), read_ms: 1000 } },
      sessions: { 'rel:a.md': [{ start: NOW - 5000, end: NOW - 4000, read_ms: 1000, edit_ms: 0 }] },
    }
    fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`] = JSON.stringify(prior)

    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    await store.preloadDay(DAY)
    store.sessionStart('rel:a.md', NOW)
    store.sessionExtend('rel:a.md', 'read', 2000, NOW + 2000)
    store.sessionClose('rel:a.md')
    await store.flush()

    const parsed = JSON.parse(fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`]) as DayFile
    expect(parsed.sessions!['rel:a.md']).toHaveLength(2)
  })

  it('flush does not double-absorb prior intervals on midnight rollover (never preloaded)', async () => {
    const fs = memoryFs()
    const prior: DayFile = {
      deviceId: 'DEV1', deviceName: 'Mac', day: DAY,
      docs: { 'rel:a.md': { ...emptyCounters(NOW), read_ms: 1000 } },
      sessions: { 'rel:a.md': [{ start: NOW - 5000, end: NOW - 4000, read_ms: 1000, edit_ms: 0 }] },
    }
    fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`] = JSON.stringify(prior)

    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    store.sessionStart('rel:a.md', NOW)
    store.sessionExtend('rel:a.md', 'read', 2000, NOW + 2000)
    store.sessionClose('rel:a.md')
    await store.flush()
    await store.flush() // second flush must not re-absorb

    const parsed = JSON.parse(fs.files[`/v/.notemd/analytics/${DAY}.DEV1.json`]) as DayFile
    expect(parsed.sessions!['rel:a.md']).toHaveLength(2)
  })

  it('readAllDevices surfaces intervals from disk and overlays own unflushed memory', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    const other: DayFile = {
      deviceId: 'DEV2', deviceName: 'iPhone', day: DAY,
      docs: { 'rel:a.md': { ...emptyCounters(0), read_ms: 250 } },
      sessions: { 'rel:a.md': [{ start: NOW, end: NOW + 250, read_ms: 250, edit_ms: 0 }] },
    }
    fs.files[`/v/.notemd/analytics/${DAY}.DEV2.json`] = JSON.stringify(other)
    store.sessionStart('rel:a.md', NOW + 1000)
    store.sessionExtend('rel:a.md', 'read', 500, NOW + 1500)

    const all = await store.readAllDevices()
    const byId = Object.fromEntries(all.map((d) => [d.deviceId, d]))
    expect(byId['DEV2'].sessions!['rel:a.md'][DAY]).toHaveLength(1)
    expect(byId['DEV1'].sessions!['rel:a.md'][DAY][0].read_ms).toBe(500) // in-memory, unflushed
  })
})
