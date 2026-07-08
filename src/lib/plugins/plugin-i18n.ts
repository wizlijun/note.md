// Resolve a plugin manifest's user-facing strings for the active UI locale,
// falling back to the manifest's English base per missing key. Reads
// `i18n.locale` so callers used in Svelte markup react to language switches.
import { i18n } from '../i18n/store.svelte'
import type { PluginManifest } from './types'

/** Localized plugin display name. */
export function pluginName(m: PluginManifest): string {
  return m.i18n?.[i18n.locale]?.name ?? m.name
}

/** Localized plugin description (may be undefined). */
export function pluginDescription(m: PluginManifest): string | undefined {
  return m.i18n?.[i18n.locale]?.description ?? m.description
}

/** Localized label for a top/context menu entry, keyed by its command. */
export function pluginMenuLabel(m: PluginManifest, command: string, fallback: string): string {
  return m.i18n?.[i18n.locale]?.menus?.[command] ?? fallback
}

export function pluginContextMenuLabel(m: PluginManifest, command: string, fallback: string): string {
  return m.i18n?.[i18n.locale]?.context_menus?.[command] ?? fallback
}

/** Localized settings tab label. */
export function pluginTabLabel(m: PluginManifest, fallback: string): string {
  return m.i18n?.[i18n.locale]?.['settings.tab_label'] ?? fallback
}

/** Localized settings field label, keyed by the field's `key`. */
export function pluginFieldLabel(m: PluginManifest, key: string, fallback: string): string {
  return m.i18n?.[i18n.locale]?.['settings.fields']?.[key] ?? fallback
}
