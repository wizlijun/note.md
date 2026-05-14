/**
 * Auto-update state machine.
 *
 * Lifecycle:
 *   idle ──init()──> checking ──found──> available ──user clicks update──> downloading ──> ready ──relaunch──> (终)
 *                       └── nothing → uptodate
 *                       └── error   → error (silent in banner; visible in Settings)
 *
 * 20h cache prevents hammering GitHub on every launch. dismissed_version
 * suppresses the banner once a user has clicked × for that specific version
 * (Settings panel still shows it).
 */
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { Store } from '@tauri-apps/plugin-store'
import { getVersion } from '@tauri-apps/api/app'

const CACHE_TTL_MS = 20 * 60 * 60 * 1000  // 20 hours, matches codex
const STARTUP_DELAY_MS = 1500
const UPDATER_STORE_FILE = 'updater.json'

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'uptodate'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

interface Persisted {
  last_checked_at: string | null
  latest_version_seen: string | null
  dismissed_version: string | null
  check_on_startup: boolean
}

const DEFAULT_PERSISTED: Persisted = {
  last_checked_at: null,
  latest_version_seen: null,
  dismissed_version: null,
  check_on_startup: true,
}

export const updater = $state<{
  state: UpdaterState
  currentVersion: string
  latestVersion: string | null
  notes: string | null
  downloaded: number
  contentLength: number | null
  error: string | null
  lastCheckedAt: string | null
  checkOnStartup: boolean
}>({
  state: 'idle',
  currentVersion: '',
  latestVersion: null,
  notes: null,
  downloaded: 0,
  contentLength: null,
  error: null,
  lastCheckedAt: null,
  checkOnStartup: true,
})

let store: Awaited<ReturnType<typeof Store.load>> | null = null
let persisted: Persisted = { ...DEFAULT_PERSISTED }
let pendingUpdate: Update | null = null
let hydrated = false

async function getStore() {
  if (!store) store = await Store.load(UPDATER_STORE_FILE)
  return store
}

async function loadPersisted(): Promise<void> {
  if (hydrated) return
  const s = await getStore()
  const raw = await s.get<Partial<Persisted>>('state')
  persisted = { ...DEFAULT_PERSISTED, ...(raw ?? {}) }
  updater.lastCheckedAt = persisted.last_checked_at
  updater.checkOnStartup = persisted.check_on_startup
  updater.latestVersion = persisted.latest_version_seen
  hydrated = true
}

async function savePersisted(): Promise<void> {
  const s = await getStore()
  await s.set('state', persisted)
  await s.save()
}

function isWithinTtl(): boolean {
  if (!persisted.last_checked_at) return false
  const last = Date.parse(persisted.last_checked_at)
  if (!Number.isFinite(last)) return false
  return Date.now() - last < CACHE_TTL_MS
}

/**
 * Compare two semver triples. Returns >0 if a > b, <0 if a < b, 0 if equal.
 * Lenient: missing parts treated as 0; non-numeric segments compared lexically.
 */
function compareVersion(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((seg) => {
    const n = Number(seg)
    return Number.isFinite(n) ? n : seg
  })
  const aa = parse(a)
  const bb = parse(b)
  const len = Math.max(aa.length, bb.length)
  for (let i = 0; i < len; i++) {
    const x = aa[i] ?? 0
    const y = bb[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x).localeCompare(String(y))
  }
  return 0
}

/**
 * Banner-visible only when we have an available update AND the user hasn't
 * dismissed THIS specific version. Settings panel uses its own visibility
 * logic (ignores dismissed_version).
 */
export function shouldShowBanner(): boolean {
  if (updater.state === 'downloading' || updater.state === 'ready') return true
  if (updater.state !== 'available') return false
  if (!updater.latestVersion) return false
  if (persisted.dismissed_version === updater.latestVersion) return false
  return true
}

/**
 * Boot-time entry point. Reads cache, optionally fires a network check.
 * Safe to call multiple times — short-circuits after the first run.
 */
let booted = false
export async function initUpdater(): Promise<void> {
  if (booted) return
  booted = true
  try {
    updater.currentVersion = await getVersion()
  } catch (e) {
    console.warn('[updater] getVersion:', e)
  }
  await loadPersisted()

  if (!persisted.check_on_startup) {
    // Even with auto-check off, if cache already shows a newer version,
    // surface it so the user isn't stuck blind.
    if (persisted.latest_version_seen
        && compareVersion(persisted.latest_version_seen, updater.currentVersion) > 0) {
      updater.state = 'available'
      updater.latestVersion = persisted.latest_version_seen
    }
    return
  }

  // Wait for first-paint before touching the network.
  await new Promise((r) => setTimeout(r, STARTUP_DELAY_MS))

  if (isWithinTtl()) {
    // Use cached result without network round-trip.
    if (persisted.latest_version_seen
        && compareVersion(persisted.latest_version_seen, updater.currentVersion) > 0) {
      updater.state = 'available'
      updater.latestVersion = persisted.latest_version_seen
      // Notes aren't cached; user can click "查看详情" to fetch fresh.
    } else {
      updater.state = 'uptodate'
    }
    return
  }

  await runCheck({ silent: true })
}

interface CheckOpts {
  silent?: boolean        // true → don't surface errors; called from startup
  forceFresh?: boolean    // true → ignore TTL; called from Settings button
}

/**
 * Hit the GitHub Releases endpoint and update state. Always updates
 * last_checked_at (even on failure) so we don't hot-loop on broken networks.
 */
export async function runCheck(opts: CheckOpts = {}): Promise<void> {
  if (updater.state === 'checking' || updater.state === 'downloading') return
  await loadPersisted()
  updater.state = 'checking'
  updater.error = null
  try {
    const result = await check()
    persisted.last_checked_at = new Date().toISOString()
    updater.lastCheckedAt = persisted.last_checked_at
    if (!result) {
      updater.state = 'uptodate'
      pendingUpdate = null
      await savePersisted()
      return
    }
    pendingUpdate = result
    updater.latestVersion = result.version
    updater.notes = result.body ?? null
    persisted.latest_version_seen = result.version
    updater.state = 'available'
    await savePersisted()
  } catch (e) {
    persisted.last_checked_at = new Date().toISOString()
    updater.lastCheckedAt = persisted.last_checked_at
    updater.state = 'error'
    updater.error = e instanceof Error ? e.message : String(e)
    await savePersisted().catch(() => {})
    if (!opts.silent) throw e
  }
}

/**
 * Dismiss the banner for the current latest version. Settings panel still
 * shows the update so users can change their mind.
 */
export async function dismissCurrent(): Promise<void> {
  if (!updater.latestVersion) return
  persisted.dismissed_version = updater.latestVersion
  await savePersisted()
}

/**
 * Toggle "check on startup". Off → never auto-checks; user can still hit
 * "立即检查更新" in Settings.
 */
export async function setCheckOnStartup(v: boolean): Promise<void> {
  persisted.check_on_startup = v
  updater.checkOnStartup = v
  await savePersisted()
}

/**
 * Download the new bundle, verify signature, replace .app in place.
 * Progress arrives via the onProgress callback Tauri gives us.
 */
export async function downloadAndInstall(): Promise<void> {
  if (!pendingUpdate) {
    // Re-fetch if state was hydrated from cache without a live handle.
    await runCheck({ forceFresh: true })
    if (!pendingUpdate) return
  }
  updater.state = 'downloading'
  updater.downloaded = 0
  updater.contentLength = null
  try {
    await pendingUpdate.downloadAndInstall((evt) => {
      switch (evt.event) {
        case 'Started':
          updater.contentLength = evt.data.contentLength ?? null
          break
        case 'Progress':
          updater.downloaded += evt.data.chunkLength
          break
        case 'Finished':
          // No-op; we flip to 'ready' after the call returns.
          break
      }
    })
    updater.state = 'ready'
  } catch (e) {
    updater.state = 'error'
    updater.error = e instanceof Error ? e.message : String(e)
    throw e
  }
}

export async function restartApp(): Promise<void> {
  await relaunch()
}

/**
 * For Settings: indicates whether there's anything to show even if the
 * banner has been dismissed. True when we know of a newer-than-current
 * version, regardless of dismissed state.
 */
export function hasUpdateForSettings(): boolean {
  if (!updater.latestVersion) return false
  return compareVersion(updater.latestVersion, updater.currentVersion) > 0
}
