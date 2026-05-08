import type { PluginManifest, Capability } from './types'

const VALID_CAPS = new Set<string>([
  'renderer.html', 'renderer.raw', 'settings.read',
  'clipboard.write', 'toast', 'dialog',
])

function isValidCapability(c: string): c is Capability {
  if (VALID_CAPS.has(c)) return true
  if (c.startsWith('settings.write:') && c.length > 'settings.write:'.length) return true
  return false
}

const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export type ValidateResult =
  | { ok: true; value: PluginManifest }
  | { ok: false; error: string }

export function validateManifest(m: unknown): ValidateResult {
  if (m == null || typeof m !== 'object') return { ok: false, error: 'manifest must be an object' }
  const o = m as Record<string, unknown>

  if (typeof o.id !== 'string' || !ID_RE.test(o.id))
    return { ok: false, error: 'id must be lowercase kebab-case' }
  if (typeof o.name !== 'string' || o.name.length === 0)
    return { ok: false, error: 'name required' }
  if (typeof o.version !== 'string' || o.version.length === 0)
    return { ok: false, error: 'version required' }
  if (typeof o.binary !== 'string' || o.binary.length === 0)
    return { ok: false, error: 'binary required' }

  if (!Array.isArray(o.host_capabilities))
    return { ok: false, error: 'host_capabilities must be an array' }
  for (const c of o.host_capabilities) {
    if (typeof c !== 'string' || !isValidCapability(c))
      return { ok: false, error: `unknown capability: ${String(c)}` }
  }

  if (o.settings != null) {
    const s = o.settings as Record<string, unknown>
    if (typeof s.tab_label !== 'string')
      return { ok: false, error: 'settings.tab_label must be string' }
    if (!Array.isArray(s.schema))
      return { ok: false, error: 'settings.schema must be an array' }
    for (const f of s.schema) {
      const fr = f as Record<string, unknown>
      if (typeof fr.key !== 'string' || !fr.key.startsWith(`${o.id}.`))
        return { ok: false, error: `settings field key '${String(fr.key)}' must start with '${o.id}.'` }
    }
  }

  return { ok: true, value: o as unknown as PluginManifest }
}

export interface Registry {
  byId: Record<string, PluginManifest>
  errors: string[]
}

export function buildRegistry(manifests: PluginManifest[]): Registry {
  const byId: Record<string, PluginManifest> = {}
  const errors: string[] = []
  for (const m of manifests) {
    if (m.id in byId) { errors.push(`duplicate plugin id '${m.id}' — keeping first`); continue }
    byId[m.id] = m
  }
  return { byId, errors }
}

export interface ShortcutConflict {
  shortcut: string
  owners: { pluginId: string; label: string }[]
  reservedCore?: boolean
}

export function findShortcutConflicts(
  manifests: PluginManifest[],
  reservedCoreShortcuts: string[],
): ShortcutConflict[] {
  const map = new Map<string, ShortcutConflict>()
  for (const m of manifests) {
    for (const me of m.menus ?? []) {
      if (!me.shortcut) continue
      const cur = map.get(me.shortcut) ?? { shortcut: me.shortcut, owners: [] }
      cur.owners.push({ pluginId: m.id, label: me.label })
      map.set(me.shortcut, cur)
    }
  }
  const conflicts: ShortcutConflict[] = []
  for (const [shortcut, c] of map) {
    const reserved = reservedCoreShortcuts.includes(shortcut)
    if (c.owners.length > 1 || reserved) {
      if (reserved) c.reservedCore = true
      conflicts.push(c)
    }
  }
  return conflicts
}
