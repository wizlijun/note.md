import type { InstalledV2 } from '../market/types'
import { localizedPluginDescription, localizedPluginName } from '../market/plugin-text'
import { normalizePluginCategory, type PluginCategory } from '../plugins/categories'
import type { PluginManifest } from '../plugins/types'

export interface HomeApp {
  id: string
  name: string
  description: string
  category: PluginCategory
  enabled: boolean
  /** Runtime manifest exists; current context gates are checked when opening. */
  available: boolean
  manifest?: PluginManifest
  entry: { kind: 'command'; command: string } | { kind: 'details' }
}

function entryFor(manifest?: PluginManifest): HomeApp['entry'] {
  const windows = Object.entries(manifest?.open_windows ?? {}).filter(([command, window]) => command.trim() && window.trim())
  const explicit = windows.find(([command]) => command === 'open')
  if (explicit) return { kind: 'command', command: explicit[0] }
  if (windows.length === 1) return { kind: 'command', command: windows[0][0] }
  if (windows.length > 1) return { kind: 'details' }
  const views = manifest?.file_views ?? []
  if (views.length === 1 && views[0].open_command?.trim()) return { kind: 'command', command: views[0].open_command }
  return { kind: 'details' }
}

export function buildHomeApps(installed: InstalledV2[], manifests: PluginManifest[], locale: string): HomeApp[] {
  const runtime = new Map(manifests.map((manifest) => [manifest.id, manifest]))
  const seen = new Set<string>()
  return installed.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  }).map((item) => {
    const manifest = runtime.get(item.id)
    const text = {
      ...item,
      name: manifest?.name ?? item.name,
      description: manifest?.description ?? item.description,
      i18n: { ...item.i18n, ...manifest?.i18n },
    }
    return {
      id: item.id,
      name: localizedPluginName(text, locale),
      description: localizedPluginDescription(text, locale) ?? '',
      category: normalizePluginCategory(item.category, item.id),
      enabled: item.enabled,
      available: manifest !== undefined,
      manifest,
      entry: entryFor(manifest),
    }
  })
}

export type AppGlyph = 'app' | 'location' | 'import' | 'health' | 'book' | 'search' | 'spark' | 'brush' | 'tasks' | 'agent' | 'dictionary' | 'decision' | 'review' | 'timeline' | 'memory' | 'pdf' | 'power'
export type AppTone = 'blue' | 'teal' | 'ochre'
export interface AppIcon { glyph: AppGlyph; tone: AppTone }

const ICONS: Readonly<Record<string, AppIcon>> = {
  'notemd.pos-log': { glyph: 'location', tone: 'teal' },
  'notemd.roam-import': { glyph: 'import', tone: 'blue' },
  'notemd.apple-notes': { glyph: 'import', tone: 'ochre' },
  'notemd.health-sync': { glyph: 'health', tone: 'teal' },
  'notemd.ebook-import': { glyph: 'book', tone: 'ochre' },
  'notemd.trace-source': { glyph: 'search', tone: 'blue' },
  'notemd.idea-spark': { glyph: 'spark', tone: 'ochre' },
  'notemd.sumi': { glyph: 'brush', tone: 'teal' },
  'notemd.next': { glyph: 'tasks', tone: 'blue' },
  'notemd.claude-agent': { glyph: 'agent', tone: 'ochre' },
  'notemd.codex-agent': { glyph: 'agent', tone: 'blue' },
  'notemd.deepseek-agent': { glyph: 'agent', tone: 'teal' },
  'notemd.conversation-dictionary': { glyph: 'dictionary', tone: 'blue' },
  'notemd.decision-log': { glyph: 'decision', tone: 'ochre' },
  'notemd.weekly-review': { glyph: 'review', tone: 'teal' },
  'notemd.timeline': { glyph: 'timeline', tone: 'blue' },
  'notemd.memory': { glyph: 'memory', tone: 'teal' },
  'notemd.md2pdf': { glyph: 'pdf', tone: 'ochre' },
  'notemd.power-mode': { glyph: 'power', tone: 'ochre' },
}

export function appIcon(id: string): AppIcon {
  return { ...(Object.hasOwn(ICONS, id) ? ICONS[id] : { glyph: 'app' as const, tone: 'blue' as const }) }
}
