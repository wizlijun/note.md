// Version selection for the market window: the registry index carries one
// entry per PUBLISHED VERSION (so older hosts keep an installable floor), but
// the UI lists one row per plugin. These helpers pick which version that row
// shows for the running host.

import { isNewerVersion, type RegistryEntry } from './types'

/**
 * True when `host` satisfies a manifest `min_host` range like ">=6.716.7"
 * (comma-separated `>=` `>` `<=` `<` `=` comparators over dotted numeric
 * versions — the subset the registry actually ships).
 *
 * Fails OPEN: an unknown host or a token this parser doesn't understand reads
 * as satisfied. Display selection must never hide a version the installer
 * might accept — the installer re-checks engines authoritatively (full semver)
 * at preview/install time.
 */
export function minHostSatisfied(range: string, host: string | null): boolean {
  if (host === null) return true
  for (const token of range.split(',')) {
    const part = token.trim()
    if (part === '' || part === '*') continue
    const m = /^(>=|<=|>|<|=)\s*(\d[\d.]*)$/.exec(part)
    if (!m) return true // unrecognized syntax — fail open
    const [, op, bound] = m
    const gt = isNewerVersion(host, bound)
    const lt = isNewerVersion(bound, host)
    const ok =
      op === '>=' ? !lt :
      op === '>' ? gt :
      op === '<=' ? !gt :
      op === '<' ? lt :
      !gt && !lt // '='
    if (!ok) return false
  }
  return true
}

/** Match the installer's host-triple / universal download and hash fallback.
 * Omitted triple preserves legacy callers; an explicitly unknown host is closed.
 */
export function platformSatisfied(entry: RegistryEntry, hostTriple?: string | null): boolean {
  if (hostTriple === undefined) return true
  if (!hostTriple) return false
  return (entry.archs.includes(hostTriple) || entry.archs.includes('universal'))
    && !!(entry.download[hostTriple] ?? entry.download.universal)
    && !!(entry.sha256[hostTriple] ?? entry.sha256.universal)
}

/** Newest entry of `candidates`; with `compatibleOnly`, only host-satisfied ones. */
function newest(candidates: RegistryEntry[], host: string | null, compatibleOnly: boolean, hostTriple?: string | null): RegistryEntry | null {
  let best: RegistryEntry | null = null
  for (const e of candidates) {
    if (compatibleOnly && (!minHostSatisfied(e.min_host, host) || !platformSatisfied(e, hostTriple))) continue
    if (!best || isNewerVersion(e.version, best.version)) best = e
  }
  return best
}

/**
 * The Available list: one entry per not-installed plugin id — the newest
 * version compatible with the host version and platform, or the newest overall
 * when none match (still discoverable; unsupported platforms cannot install).
 * Sorted by id.
 */
export function pickAvailable(
  entries: RegistryEntry[],
  installedIds: ReadonlySet<string>,
  host: string | null,
  hostTriple?: string | null,
): RegistryEntry[] {
  const byId = new Map<string, RegistryEntry[]>()
  for (const e of entries) {
    if (installedIds.has(e.id)) continue
    const group = byId.get(e.id)
    if (group) group.push(e)
    else byId.set(e.id, [e])
  }
  const picked: RegistryEntry[] = []
  for (const group of byId.values()) {
    const e = newest(group, host, true, hostTriple) ?? newest(group, host, false)
    if (e) picked.push(e)
  }
  // By id, not display name: names are localized, so sorting on them makes the
  // catalogue reorder itself when the app language changes.
  return picked.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Update target for an installed plugin: the newest host-compatible version
 * strictly newer than the installed one, or null when up to date (an
 * incompatible newer version is NOT offered — the update would only fail).
 */
export function pickUpdateTo(
  entries: RegistryEntry[],
  id: string,
  installedVersion: string,
  host: string | null,
  hostTriple?: string | null,
): string | null {
  const candidates = entries.filter((e) => e.id === id)
  const best = newest(candidates, host, true, hostTriple)
  return best && isNewerVersion(best.version, installedVersion) ? best.version : null
}
