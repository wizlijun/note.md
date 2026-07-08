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

/**
 * On-disk shape of ONE `<YYYY-MM-DD>.<device_id>.json` file: a single device's
 * engagement for a single day. Partitioning per day keeps every file small and
 * bounded (older days are written once and never touched again — git-friendly),
 * instead of one ever-growing file per device.
 */
export interface DayFile {
  deviceId: string
  deviceName: string
  day: string
  /** docKey -> counters (day is implicit from the filename). */
  docs: Record<string, DayCounters>
}

const SUBDIR = '.mdeditor/analytics'
/** `2026-07-08.<device_id>.json` — day (no dots) then deviceId (a UUID, no dots). */
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.(.+)\.json$/

function analyticsDir(vaultRoot: string): string {
  return `${vaultRoot.replace(/\/$/, '')}/${SUBDIR}`
}

function fileNameFor(day: string, deviceId: string): string {
  return `${day}.${deviceId}.json`
}

export function createAnalyticsStore(cfg: AnalyticsStoreConfig) {
  /** In-memory, docKey-major: docKey -> day -> counters. */
  const docs: DocDays = {}
  /** Days accrued (or preloaded) this session — only these get (re)written on flush. */
  const dirtyDays = new Set<string>()

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
    dirtyDays.add(day)
  }

  function snapshot(): DocDays {
    return docs
  }

  /**
   * Seed the in-memory buckets for `day` from this device's on-disk file (if any),
   * so a later flush MERGES with — rather than overwrites — data written by an
   * earlier session on the same day. Marks the day clean (not re-flushed unless
   * subsequently accrued). Call once per session for today, before accruing.
   */
  async function preloadDay(day: string): Promise<void> {
    const root = cfg.vaultRoot()
    if (!root) return
    const file = `${analyticsDir(root)}/${fileNameFor(day, cfg.deviceId)}`
    if (!(await cfg.fs.exists(file).catch(() => false))) return
    try {
      const parsed = JSON.parse(await cfg.fs.readTextFile(file)) as DayFile
      if (parsed && parsed.docs) {
        for (const [docKey, counters] of Object.entries(parsed.docs)) {
          ;(docs[docKey] ??= {})[day] = counters
        }
      }
    } catch {
      // Skip corrupt / partially-written files.
    }
    dirtyDays.delete(day)
  }

  /** Convenience: preload the device's local "today" bucket. */
  function preloadToday(now = Date.now()): Promise<void> {
    return preloadDay(dayKey(now, cfg.tzOffsetMinutes))
  }

  /** Collect this device's in-memory docKey->counters for a single day. */
  function docsForDay(day: string): Record<string, DayCounters> {
    const out: Record<string, DayCounters> = {}
    for (const [docKey, days] of Object.entries(docs)) {
      if (days[day]) out[docKey] = days[day]
    }
    return out
  }

  /**
   * Write one file per dirty day: `<day>.<deviceId>.json`. Only touched days are
   * rewritten, so historical files stay stable. No-op without a vault.
   */
  async function flush(): Promise<void> {
    const root = cfg.vaultRoot()
    if (!root) return
    if (dirtyDays.size === 0) return
    const dir = analyticsDir(root)
    await cfg.fs.mkdir(dir, { recursive: true }).catch(() => {})
    for (const day of dirtyDays) {
      const file: DayFile = {
        deviceId: cfg.deviceId,
        deviceName: cfg.deviceName,
        day,
        docs: docsForDay(day),
      }
      await cfg.fs.writeTextFile(`${dir}/${fileNameFor(day, cfg.deviceId)}`, JSON.stringify(file, null, 2))
    }
    dirtyDays.clear()
  }

  /**
   * Read every device's full history from disk and reconstruct one
   * `DeviceAnalytics` per device (docKey -> day -> counters). This device's live
   * in-memory buckets are overlaid on top of its own on-disk files so unflushed
   * accruals are included and always win.
   */
  async function readAllDevices(): Promise<DeviceAnalytics[]> {
    const own: DeviceAnalytics = { deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs }
    const root = cfg.vaultRoot()
    if (!root) return [own]
    const dir = analyticsDir(root)
    if (!(await cfg.fs.exists(dir).catch(() => false))) return [own]

    const byDevice = new Map<string, DeviceAnalytics>()
    const entries = await cfg.fs.readDir(dir).catch(() => [])
    for (const ent of entries) {
      if (!ent.isFile) continue
      const m = FILE_RE.exec(ent.name)
      if (!m) continue
      const [, day, deviceId] = m
      try {
        const parsed = JSON.parse(await cfg.fs.readTextFile(`${dir}/${ent.name}`)) as DayFile
        if (!parsed || !parsed.docs) continue
        let dev = byDevice.get(deviceId)
        if (!dev) {
          dev = { deviceId, deviceName: parsed.deviceName ?? deviceId, docs: {} }
          byDevice.set(deviceId, dev)
        }
        for (const [docKey, counters] of Object.entries(parsed.docs)) {
          ;(dev.docs[docKey] ??= {})[day] = counters
        }
      } catch {
        // Skip corrupt / partially-written files.
      }
    }

    // Overlay this device's live in-memory buckets (freshest — includes unflushed).
    const ownDev = byDevice.get(cfg.deviceId) ?? { deviceId: cfg.deviceId, deviceName: cfg.deviceName, docs: {} }
    for (const [docKey, days] of Object.entries(docs)) {
      const target = (ownDev.docs[docKey] ??= {})
      for (const [day, counters] of Object.entries(days)) target[day] = counters
    }
    byDevice.set(cfg.deviceId, ownDev)

    return [...byDevice.values()]
  }

  return { accrue, snapshot, preloadDay, preloadToday, flush, readAllDevices }
}

export type AnalyticsStore = ReturnType<typeof createAnalyticsStore>
