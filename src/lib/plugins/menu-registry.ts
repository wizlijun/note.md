import type { PluginManifest, EnabledWhenContext } from './types'
import { evaluateEnabledWhen } from './enabled-when'

export interface CollectedItem {
  id: string                    // 'plugin:<pluginId>:<command>'
  pluginId: string
  command: string
  label: string
  shortcut?: string
  enabledWhen?: string
}

export interface CollectedItems {
  file: CollectedItem[]
  edit: CollectedItem[]
  view: CollectedItem[]
  window: CollectedItem[]
  help: CollectedItem[]
  plugins: CollectedItem[]
  tabContext: CollectedItem[]
  editorContext: CollectedItem[]
}

export function mkPluginMenuId(pluginId: string, command: string): string {
  return `plugin:${pluginId}:${command}`
}

export function parsePluginMenuId(id: string): { pluginId: string; command: string } | null {
  if (!id.startsWith('plugin:')) return null
  const rest = id.slice('plugin:'.length)
  const sep = rest.indexOf(':')
  if (sep < 0) return null
  return { pluginId: rest.slice(0, sep), command: rest.slice(sep + 1) }
}

export function collectMenuItems(manifests: PluginManifest[]): CollectedItems {
  const out: CollectedItems = {
    file: [], edit: [], view: [], window: [], help: [], plugins: [],
    tabContext: [], editorContext: [],
  }
  for (const m of manifests) {
    for (const me of m.menus ?? []) {
      const item: CollectedItem = {
        id: mkPluginMenuId(m.id, me.command),
        pluginId: m.id, command: me.command,
        label: me.label, shortcut: me.shortcut, enabledWhen: me.enabled_when,
      }
      out[me.location].push(item)
    }
    for (const ce of m.context_menus ?? []) {
      const item: CollectedItem = {
        id: mkPluginMenuId(m.id, ce.command),
        pluginId: m.id, command: ce.command,
        label: ce.label, enabledWhen: ce.enabled_when,
      }
      if (ce.location === 'tab') out.tabContext.push(item)
      else out.editorContext.push(item)
    }
  }
  return out
}

export function evaluateEnabled(item: CollectedItem, ctx: EnabledWhenContext): boolean {
  if (!item.enabledWhen) return true
  try { return evaluateEnabledWhen(item.enabledWhen, ctx) }
  catch (e) {
    console.warn(`[plugin:${item.pluginId}] enabled_when error`, e)
    return false
  }
}
