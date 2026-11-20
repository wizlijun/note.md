import { basename, dirname, normalize } from '../paths'
import type { DeviceAnalytics } from '../insights/model'

export const READ_MS = 30_000
export const CONTINUE_MS = 60_000
export const INITIAL_DAYS = 30
export interface ContentCandidate {
  path: string
  title: string | null
  conceptType: string | null
  createdAt: number | null
  modifiedAt: number
  preview?: string | null
}
export interface ContentActivity {
  path: string
  discoveredAt: number
  readMs: number
  readAt: number
  lastReadAt: number
  lastEditedAt: number
  dismissedNew: boolean
  dismissedContinueAt: number
}
export interface VaultContent {
  initializedAt: number
  migrated: boolean
  docs: Record<string, ContentActivity>
  /** First-time New content dismissals per direct parent, local to this Vault and device. */
  folderDismissals: Record<string, number>
}
export const emptyVaultContent = (): VaultContent => ({ initializedAt: 0, migrated: false, docs: {}, folderDismissals: {} })
export interface HomeContentData { version: 1; vaults: Record<string, VaultContent> }
export interface HomeContentItem { path: string; title: string; detail: string; at: number; preview?: string }
export type ContentList = 'new' | 'continue'
export const emptyHomeContent = (): HomeContentData => ({ version: 1, vaults: {} })
const FOLDER_DISMISSAL_LIMIT = 4
const time = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function contentKey(path: string, root: string): string {
  const p = normalize(path), prefix = normalize(root).replace(/\/$/, '') + '/'
  return p.startsWith(prefix) ? `rel:${p.slice(prefix.length)}` : `abs:${p}`
}
export function contentPath(key: string, root: string): string | null {
  if (key.startsWith('abs:')) return key.slice(4)
  const rel = key.slice(4)
  return key.startsWith('rel:') && rel && !rel.split('/').some(p => p === '..' || p === '.')
    ? normalize(root).replace(/\/$/, '') + '/' + rel : null
}
export function activityFor(vault: VaultContent, path: string, root: string, now: number): ContentActivity {
  return vault.docs[contentKey(path, root)] ??= {
    path: normalize(path), discoveredAt: now, readMs: 0, readAt: 0,
    lastReadAt: 0, lastEditedAt: 0, dismissedNew: false, dismissedContinueAt: 0,
  }
}
export function normalizeHomeContent(value: unknown): HomeContentData {
  const out = emptyHomeContent()
  if (!object(value) || value.version !== 1 || !object(value.vaults)) return out
  for (const [root, raw] of Object.entries(value.vaults)) {
    if (!object(raw) || !object(raw.docs)) continue
    const vault: VaultContent = { ...emptyVaultContent(), initializedAt: time(raw.initializedAt), migrated: raw.migrated === true }
    if (object(raw.folderDismissals)) {
      const counts: Array<[string, number]> = []
      for (const [folder, count] of Object.entries(raw.folderDismissals)) {
        if (normalizeDirRule(folder) && !folder.startsWith('/') && typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
          counts.push([folder, Math.min(count, FOLDER_DISMISSAL_LIMIT)])
        }
      }
      vault.folderDismissals = Object.fromEntries(counts)
    }
    for (const [key, item] of Object.entries(raw.docs)) {
      const path = contentPath(key, root)
      if (!path || !object(item)) continue
      vault.docs[key] = {
        path, discoveredAt: time(item.discoveredAt), readMs: time(item.readMs), readAt: time(item.readAt),
        lastReadAt: time(item.lastReadAt), lastEditedAt: time(item.lastEditedAt),
        dismissedNew: item.dismissedNew === true, dismissedContinueAt: time(item.dismissedContinueAt),
      }
    }
    out.vaults[root] = vault
  }
  return out
}

// Reserved control/index names are documented in the Vault's AGENTS template.
const CONTROL_NAMES = new Set(['index.md', 'log.md', 'agents.md', 'claude.md', 'user.md', 'memory.md'])
const PROCESS_DIRS = new Set(['.git', '.notemd', '.trash', 'node_modules', '.cache', 'cache', 'logs', 'tmp', 'temp', 'skills'])
const CONTROL_TYPES = new Set(['book topic index', 'vault conventions', 'user profile', 'memory', 'skill', 'next'])
export function isNewContent(candidate: ContentCandidate, root: string): boolean {
  const key = contentKey(candidate.path, root)
  if (!key.startsWith('rel:')) return false
  const parts = key.slice(4).toLowerCase().split('/')
  return !CONTROL_NAMES.has(parts.at(-1)!) && !parts.slice(0, -1).some(p => PROCESS_DIRS.has(p))
    && !CONTROL_TYPES.has((candidate.conceptType ?? '').toLowerCase())
}

/** Vault directory rules for the new list (`.notemd/settings.json`, `homeNew*Dirs`). */
export interface HomeDirRules { exclude: string[]; include: string[] }
export const noDirRules: HomeDirRules = { exclude: [], include: [] }

/** Tolerates hand-edited settings: `./a/`, ` a/b/ ` → `a`, `a/b`; empty or escaping → null. */
export function normalizeDirRule(raw: string): string | null {
  const parts = raw.trim().split(/[\\/]/).map(p => p.trim()).filter(p => p && p !== '.')
  return parts.length && !parts.includes('..') ? parts.join('/') : null
}
const under = (rel: string, dir: string) => {
  const r = rel.toLowerCase(), d = dir.toLowerCase()
  return r === d || r.startsWith(d + '/')
}
const ruleDirs = (list: string[]) => list.map(normalizeDirRule).filter((d): d is string => d !== null)
/** `rel` is vault-relative. Exclusions win; an empty include list means no limit. */
export function passesDirRules(rel: string, rules: HomeDirRules): boolean {
  if (ruleDirs(rules.exclude).some(d => under(rel, d))) return false
  const include = ruleDirs(rules.include)
  return !include.length || include.some(d => under(rel, d))
}
export function automaticallyExcludedFolders(vault: VaultContent): string[] {
  return Object.keys(vault.folderDismissals).filter(dir => vault.folderDismissals[dir] >= FOLDER_DISMISSAL_LIMIT)
    .sort((a, b) => a.localeCompare(b))
}

export function discoverContent(vault: VaultContent, candidates: ContentCandidate[], root: string, now: number): void {
  const initial = vault.initializedAt === 0
  for (const c of candidates) {
    const key = contentKey(c.path, root)
    if (vault.docs[key] && !initial) continue
    const entry = activityFor(vault, c.path, root, now)
    // Unknown-date existing files are baseline, rather than a fabricated inbox.
    entry.discoveredAt = initial ? (c.createdAt ?? 0) : now
    if (entry.discoveredAt > now) entry.discoveredAt = now
  }
  if (initial) vault.initializedAt = now
}

/** Owner history only. Audience analytics never enter personal reading state. */
export function migrateOwnerHistory(vault: VaultContent, devices: DeviceAnalytics[], root: string): void {
  if (vault.migrated) return
  for (const device of devices) for (const [key, days] of Object.entries(device.docs)) {
    const path = contentPath(key, root)
    if (!path) continue
    const doc = activityFor(vault, path, root, 0)
    for (const c of Object.values(days)) {
      // Source-mode attention is still reading; it is not proof of an edit.
      doc.readMs += time(c.read_ms) + time(c.edit_ms)
      if (doc.readMs >= READ_MS) doc.readAt = Math.max(doc.readAt, time(c.last_active_at))
    }
    for (const sessions of Object.values(device.sessions?.[key] ?? {})) for (const session of sessions) {
      if (time(session.read_ms) + time(session.edit_ms) >= CONTINUE_MS) {
        doc.lastReadAt = Math.max(doc.lastReadAt, time(session.end))
      }
    }
  }
  vault.migrated = true
}

export function applyAttention(doc: ContentActivity, totalReadMs: number, visitMs: number, now: number): void {
  doc.readMs = Math.max(doc.readMs, totalReadMs)
  if (doc.readMs >= READ_MS) doc.readAt ||= now
  if (visitMs >= CONTINUE_MS) doc.lastReadAt = Math.max(doc.lastReadAt, now)
}
export function applyEdit(doc: ContentActivity, now: number): void {
  doc.readAt ||= now
  doc.lastEditedAt = Math.max(doc.lastEditedAt, now)
}
export function dismissContent(vault: VaultContent, path: string, root: string, list: ContentList, now: number, dirRules: HomeDirRules = noDirRules): void {
  const doc = activityFor(vault, path, root, now)
  if (list === 'continue') {
    doc.dismissedContinueAt = Math.max(now, doc.lastReadAt, doc.lastEditedAt)
    return
  }
  if (doc.dismissedNew) return
  doc.dismissedNew = true
  const key = contentKey(path, root)
  if (!key.startsWith('rel:')) return
  const relative = key.slice(4)
  const parent = dirname(relative)
  // A root file must never count towards excluding the whole Vault.
  if (parent === '.' || !passesDirRules(relative, dirRules)) return
  const count = Object.hasOwn(vault.folderDismissals, parent) ? vault.folderDismissals[parent] : 0
  if (count < FOLDER_DISMISSAL_LIMIT) vault.folderDismissals = { ...vault.folderDismissals, [parent]: count + 1 }
}
export function contentLists(vault: VaultContent, candidates: ContentCandidate[], root: string, now: number, limit = 10, unavailable: ReadonlySet<string> = new Set(), dirRules: HomeDirRules = noDirRules) {
  const metadata = new Map(candidates.map(c => [contentKey(c.path, root), c]))
  const newItems: HomeContentItem[] = [], continueItems: HomeContentItem[] = []
  const cutoff = vault.initializedAt - INITIAL_DAYS * 86_400_000
  const automatic = automaticallyExcludedFolders(vault)
  for (const [key, doc] of Object.entries(vault.docs)) {
    const c = metadata.get(key)
    // A completed catalog is authoritative for Vault documents; external paths
    // are checked by the store, rather than being lost at the Vault boundary.
    if (key.startsWith('rel:') && !c) continue
    const path = c?.path ?? doc.path
    if (unavailable.has(path)) continue
    const item = { path, title: c?.title?.trim() || basename(path), detail: key.startsWith('rel:') ? dirname(key.slice(4)) : dirname(path), at: 0,
      ...(c?.preview?.trim() ? { preview: c.preview.trim() } : {}) }
    const activeAt = Math.max(doc.lastReadAt, doc.lastEditedAt)
    if (activeAt > doc.dismissedContinueAt) continueItems.push({ ...item, at: activeAt })
    if (!c || !isNewContent(c, root) || doc.readAt || doc.dismissedNew || doc.discoveredAt <= 0 || doc.discoveredAt < cutoff || doc.discoveredAt > now) continue
    const relative = key.slice(4)
    if (automatic.some(dir => relative.startsWith(dir + '/')) || !passesDirRules(relative, dirRules)) continue
    newItems.push({ ...item, at: doc.discoveredAt })
  }
  const order = (a: HomeContentItem, b: HomeContentItem) => b.at - a.at || a.path.localeCompare(b.path)
  return { newItems: newItems.sort(order).slice(0, limit), continueItems: continueItems.sort(order).slice(0, limit) }
}
