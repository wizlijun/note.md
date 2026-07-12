import { invoke } from '@tauri-apps/api/core'
import type { Tab } from '../tabs.svelte'
import { renderTabAsInlineBody } from '../plugins/host-render-html'
import { wrapPrintHtml } from '../print'

/** Open (or focus+refresh) a native preview window. `label` is unique per
 *  (kind + version) so the same version reuses its window and different
 *  versions open side-by-side. */
async function open(label: string, title: string, kind: 'diff' | 'rich', content: string): Promise<void> {
  await invoke('open_preview_window', { label, title, kind, content })
}

/** A unified diff (git show / git diff) in a native window. */
export async function openDiffPreview(short: string, title: string, diff: string): Promise<void> {
  await open(`preview-diff-${short}`, title, 'diff', diff)
}

/** Diff of the selected version against the live editor buffer, in a window. */
export async function openComparePreview(short: string, title: string, diff: string): Promise<void> {
  await open(`preview-cmp-${short}`, title, 'diff', diff)
}

/** Rich (rendered markdown) preview of a past version, in a window. Renders the
 *  historical markdown through the same pipeline as print/PDF into a
 *  self-contained styled HTML document. */
export async function openRichPreview(short: string, title: string, tab: Tab, markdown: string): Promise<void> {
  const synthetic: Tab = { ...tab, currentContent: markdown, initialContent: markdown }
  const body = await renderTabAsInlineBody(synthetic)
  const html = wrapPrintHtml(body, title)
  await open(`preview-rich-${short}`, title, 'rich', html)
}
