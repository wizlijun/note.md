import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '../tabs.svelte'
import { bakeThemedPreviewHtml } from '../plugins/share-baker'
import { activeTheme } from '../active-theme.svelte'

/** Open (or add a tab to) the single native preview window. `tabId` is unique
 *  per (kind + version) so the same version reuses its tab; different
 *  versions/kinds get their own tabs. */
async function open(tabId: string, title: string, kind: 'diff' | 'rich', content: string): Promise<void> {
  await invoke('open_preview_tab', { tabId, title, kind, content })
}

/** A unified diff (git show / git diff) as a preview tab. */
export async function openDiffPreview(short: string, title: string, diff: string): Promise<void> {
  await open(`diff-${short}`, title, 'diff', diff)
}

/** Diff of the selected version against the live editor buffer, as a tab. */
export async function openComparePreview(short: string, title: string, diff: string): Promise<void> {
  await open(`cmp-${short}`, title, 'diff', diff)
}

/** Rich (rendered markdown) preview of a past version, as a tab. Rendered with
 *  the user's CURRENT theme via `bakeThemedPreviewHtml`. */
export async function openRichPreview(short: string, title: string, tab: Tab, markdown: string): Promise<void> {
  const synthetic: Tab = { ...tab, currentContent: markdown, initialContent: markdown }
  const html = await bakeThemedPreviewHtml(synthetic, activeTheme.id)
  await open(`rich-${short}`, title, 'rich', html)
}
