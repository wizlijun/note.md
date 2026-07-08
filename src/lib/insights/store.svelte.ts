import { dayKey, emptyCounters, type DayCounters, type DeviceAnalytics, type DocDays } from './model'

/** Minimal filesystem surface (injectable for tests; bound to plugin-fs in prod). */
export interface Fs {
  exists(path: string): Promise<boolean>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  readDir(path: string): Promise<Array<{ name: string; isFile: boolean }>>
  readTextFile(path: string): Promise<string>
  writeTextFile(path: string, content: string): Promise<void>
}

export interface AnalyticsStoreConfig {
  fs: Fs
  vaultRoot: () => string | null
  deviceId: string
  deviceName: string
  tzOffsetMinutes: number
}

const SUBDIR = '.mdeditor/analytics'

function analyticsDir(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/$/, '')}/${SUBDIR}`
}

export function createAnalyticsStore(cfg: AnalyticsStoreConfig) {
  const docs: DocDays = {}

  function accrue(docKey: string, patch: Partial<DayCounters>, now: number): void {
    const day = dayKey(now, cfg.tzOffsetMinutes)
    const perDoc = (docs[docKey] ??= {})
    const bucket = (perDoc[day] ??= emptyCounters(now))
    bucket.read_ms += patch.read_ms ?? 0
    bucket.edit_ms += patch.edit_ms ?? 0
    bucket.open_count += patch.open_count ?? 0
    bucket.edit_sessions += patch.edit_sessions ?? 0
    bucket.net_chars += patch.net_chars ?? 0
    bucket.mark_ops += patch.mark_ops ?? 0
    bucket.first_seen_at = Math.min(bucket.first_seen_at, now)
    bucket.last_active_at = Math.max(bucket.last_active_at, now)
  }

  function snapshot(): DocDays {
    return docs
  }

  async function flush(): Promise<void> {
    const root = cfg.vaultRoot()
    if (!root) return
    const dir = analyticsDir(root)
    await cfg.fs.mkdir(dir, { recursive: true }).catch(() => {})
    const doc: DeviceAnalytics = { deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs }
    await cfg.fs.writeTextFile(`${dir}/${cfg.deviceId}.json`, JSON.stringify(doc, null, 2))
  }

  async function readAllDevices(): Promise<DeviceAnalytics[]> {
    const root = cfg.vaultRoot()
    if (!root) return [{ deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs }]
    const dir = analyticsDir(root)
    if (!(await cfg.fs.exists(dir).catch(() => false))) {
      return [{ deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs }]
    }
    const out: DeviceAnalytics[] = []
    const ownFile = `${cfg.deviceId}.json`
    const entries = await cfg.fs.readDir(dir).catch(() => [])
    for (const ent of entries) {
      if (!ent.isFile || !ent.name.endsWith('.json') || ent.name === ownFile) continue
      try {
        const parsed = JSON.parse(await cfg.fs.readTextFile(`${dir}/${ent.name}`)) as DeviceAnalytics
        if (parsed && parsed.docs) out.push(parsed)
      } catch {
        // Skip corrupt / partially-written files.
      }
    }
    // Include this device's live in-memory state (fresher than any on-disk copy).
    out.push({ deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs })
    return out
  }

  return { accrue, snapshot, flush, readAllDevices }
}

export type AnalyticsStore = ReturnType<typeof createAnalyticsStore>
