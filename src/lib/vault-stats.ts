import { documentFileRules, classifyPath } from './fs'
import { buildCustomEditorRegistry } from './plugins/custom-editors'
import { isValidFileView } from './plugins/file-views'
import type { PluginManifest } from './plugins/types'

export interface VaultStats {
  root: string
  documents: number
  files: number
  bytes: number
  skipped: number
  completedAt: number | null
}

// Extension declarations identify formats. Content/path-only views merely offer
// another presentation of an existing document and must not turn every file into one.
export function vaultDocumentRules(manifests: PluginManifest[]) {
  const rules = documentFileRules()
  const extensions = new Set(rules.extensions)
  const media = /^(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp|mp[34]|m4[av]|mov|avi|wav|ogg|flac|webm|aac)$/i
  const add = (raw: string) => {
    const ext = raw.replace(/^\.+/, '').toLowerCase()
    if (/^[a-z0-9][a-z0-9_-]*$/.test(ext) && !media.test(ext) && classifyPath(`file.${ext}`)?.kind !== 'image') extensions.add(ext)
  }
  for (const ext of buildCustomEditorRegistry(manifests).keys()) add(ext)
  for (const manifest of manifests) {
    for (const view of manifest.file_views ?? []) {
      if (!isValidFileView(view)) continue
      for (const selector of view.selectors) for (const ext of selector.file_extensions ?? []) add(ext)
    }
  }
  return { extensions: [...extensions].sort(), names: rules.names.sort() }
}

export function formatContentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
  return `${value.toFixed(1)} ${units[index]}`
}
