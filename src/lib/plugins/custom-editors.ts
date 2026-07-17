/**
 * Custom-editor registry (子项目④).
 *
 * Scans loaded plugin manifests for `contributes.custom_editors` and builds a
 * `file extension → editor` map so `openFile` can route a `.base` (or any
 * claimed extension) to a plugin-served iframe editor instead of a built-in
 * view. The extension is stored WITHOUT a leading dot and lowercased, matching
 * how `classifyPath` derives extensions.
 *
 * v1 plugins never carry `custom_editors`, so a v1-only host yields an empty
 * map and the whole feature stays inert.
 */

import type { PluginManifest } from './types'

/** What a registered custom editor needs to render its iframe. */
export interface CustomEditorRef {
  pluginId: string
  editorId: string
  /** UI-relative entry path served under `plugin://<pluginId>/`. */
  entry: string
}

/** Normalise an extension token to bare-lowercase (`'.Base'` → `'base'`). */
function normExt(ext: string): string {
  return ext.replace(/^\.+/, '').toLowerCase()
}

/**
 * Build a `Map<ext, CustomEditorRef>` from every plugin's `custom_editors`.
 *
 * Extensions are keyed bare + lowercased. When two plugins claim the same
 * extension the FIRST one wins (manifests are iterated in array order); a
 * warning is logged so the collision is visible. A plugin with no
 * `custom_editors` contributes nothing.
 */
export function buildCustomEditorRegistry(
  manifests: PluginManifest[],
): Map<string, CustomEditorRef> {
  const map = new Map<string, CustomEditorRef>()
  for (const m of manifests) {
    const editors = m.custom_editors
    if (!editors || editors.length === 0) continue
    for (const ed of editors) {
      if (!ed || !ed.id || !ed.entry || !Array.isArray(ed.file_extensions)) continue
      const ref: CustomEditorRef = { pluginId: m.id, editorId: ed.id, entry: ed.entry }
      for (const raw of ed.file_extensions) {
        const ext = normExt(raw)
        if (!ext) continue
        if (map.has(ext)) {
          console.warn(
            `[custom-editors] extension '.${ext}' claimed by both ` +
              `'${map.get(ext)!.pluginId}' and '${m.id}'; keeping the first`,
          )
          continue
        }
        map.set(ext, ref)
      }
    }
  }
  return map
}

/**
 * Look up the custom editor registered for `ext` (with or without a leading
 * dot) across `manifests`, or `null` when none is registered. Convenience
 * wrapper over `buildCustomEditorRegistry` for one-off lookups.
 */
export function customEditorFor(
  ext: string,
  manifests: PluginManifest[],
): CustomEditorRef | null {
  return buildCustomEditorRegistry(manifests).get(normExt(ext)) ?? null
}
