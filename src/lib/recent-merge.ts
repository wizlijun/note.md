/** One file's worth of a single device's recent history (synced via git). */
export interface SyncedEntry {
  /** Vault-relative path (set when the file lives inside the Vault). */
  rel?: string
  /** Absolute path (set when the file lives outside the Vault). */
  abs?: string
  /** Last-opened time, ms since epoch. */
  lastOpened: number
}

export interface DeviceRecents {
  deviceId: string
  deviceName: string
  entries: SyncedEntry[]
}

/** A recent resolved to an absolute path on THIS device. */
export interface ResolvedRecent {
  path: string
  lastOpened: number
}

function withTrailingSlash(root: string): string {
  return root.endsWith('/') ? root : root + '/'
}

export function isUnder(path: string, root: string): boolean {
  if (path === root) return true
  return path.startsWith(withTrailingSlash(root))
}

/** Classify a local absolute path for storage in this device's synced file. */
export function toSyncedEntry(absPath: string, lastOpened: number, vaultRoot: string | null): SyncedEntry {
  if (vaultRoot && isUnder(absPath, vaultRoot)) {
    return { rel: absPath.slice(withTrailingSlash(vaultRoot).length), lastOpened }
  }
  return { abs: absPath, lastOpened }
}

/** Resolve a synced entry to an absolute path on this device, or null if unresolvable. */
export function resolveEntry(e: SyncedEntry, vaultRoot: string | null): ResolvedRecent | null {
  if (e.rel != null) {
    if (!vaultRoot) return null
    return { path: withTrailingSlash(vaultRoot) + e.rel, lastOpened: e.lastOpened }
  }
  if (e.abs != null) return { path: e.abs, lastOpened: e.lastOpened }
  return null
}

/**
 * Merge this device's recents with every other device's synced file.
 * Dedups by absolute path (keeping the most-recent lastOpened), drops
 * tombstoned paths, sorts newest-first, and caps at `limit`.
 */
export function mergeRecents(
  local: ResolvedRecent[],
  deviceFiles: DeviceRecents[],
  vaultRoot: string | null,
  tombstones: string[],
  limit = 10,
): string[] {
  const byPath = new Map<string, number>()
  const add = (path: string, ts: number) => {
    const prev = byPath.get(path)
    if (prev === undefined || ts > prev) byPath.set(path, ts)
  }
  for (const r of local) add(r.path, r.lastOpened)
  for (const f of deviceFiles) {
    for (const e of f.entries) {
      const r = resolveEntry(e, vaultRoot)
      if (r) add(r.path, r.lastOpened)
    }
  }
  const tomb = new Set(tombstones)
  return [...byPath.entries()]
    .filter(([p]) => !tomb.has(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([p]) => p)
}

/**
 * Native macOS menu items have no tooltip, so the full path lives in the label:
 * `filename — ~/parent/dir` (home-abbreviated).
 */
export function formatRecentLabel(absPath: string, home: string | null): string {
  const i = absPath.lastIndexOf('/')
  const name = i >= 0 ? absPath.slice(i + 1) : absPath
  const dir = i > 0 ? absPath.slice(0, i) : ''
  const h = home ? home.replace(/\/$/, '') : null
  const shownDir = h && (dir === h || dir.startsWith(h + '/')) ? '~' + dir.slice(h.length) : dir
  return shownDir ? `${name} — ${shownDir}` : name
}
