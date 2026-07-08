import { describe, it, expect } from 'vitest'
import { createAnalyticsStore, type Fs } from './store.svelte'
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

describe('analytics store', () => {
  it('accrues counter deltas into the correct local day bucket', () => {
    const store = createAnalyticsStore({ fs: memoryFs(), vaultRoot: () => '/v', ...CFG })
    const now = Date.UTC(2026, 6, 8, 7, 0) // UTC+8 → 2026-07-08 15:00 local
    store.accrue('rel:a.md', { read_ms: 500, mark_ops: 2 }, now)
    const days = store.snapshot()['rel:a.md']
    expect(days['2026-07-08'].read_ms).toBe(500)
    expect(days['2026-07-08'].mark_ops).toBe(2)
  })

  it('flush writes this device file; readAllDevices reads every device file back', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => '/v', ...CFG })
    store.accrue('rel:a.md', { read_ms: 500 }, Date.UTC(2026, 6, 8, 7, 0))
    await store.flush()
    expect(fs.files['/v/.mdeditor/analytics/DEV1.json']).toContain('rel:a.md')

    // A second device's file already on disk.
    fs.files['/v/.mdeditor/analytics/DEV2.json'] = JSON.stringify({
      deviceId: 'DEV2', deviceName: 'iPhone',
      docs: { 'rel:a.md': { '2026-07-08': { ...emptyCounters(0), read_ms: 250 } } },
    })
    const all = await store.readAllDevices()
    const ids = all.map((d) => d.deviceId).sort()
    expect(ids).toEqual(['DEV1', 'DEV2'])
  })

  it('flush is a no-op when no vault is configured', async () => {
    const fs = memoryFs()
    const store = createAnalyticsStore({ fs, vaultRoot: () => null, ...CFG })
    store.accrue('rel:a.md', { read_ms: 500 }, Date.UTC(2026, 6, 8, 7, 0))
    await store.flush()
    expect(Object.keys(fs.files)).toHaveLength(0)
  })
})
