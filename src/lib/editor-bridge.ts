import 'katex/dist/katex.min.css'
import { createEditor as coreCreateEditor, type MorayaEditorInstance } from '@moraya/core'
import { tauriMediaResolver } from './adapters/tauri-media-resolver'
import { tauriLinkOpener } from './adapters/tauri-link-opener'
import { emptyRendererRegistry } from './adapters/empty-renderer-registry'
import { activeTab } from './tabs.svelte'

const platform = {
  getCurrentFilePath: () => activeTab()?.filePath ?? null,
  isMacOS: true,
}

/**
 * Mount a rich-text @moraya/core editor.
 *
 * `initialContent` is now an explicit parameter (was previously read from
 * tab.currentContent inside this function). This lets callers wrap content
 * in a fenced code block for code-kind tabs without coupling the bridge
 * to file-kind logic.
 */
export async function mountRichEditor(
  root: HTMLElement,
  initialContent: string,
  onChange: (md: string) => void,
): Promise<MorayaEditorInstance> {
  return coreCreateEditor({
    container: root,
    initialContent,
    mediaResolver: tauriMediaResolver,
    rendererRegistry: emptyRendererRegistry,
    linkOpener: tauriLinkOpener,
    platform,
    enableMath: true,
    enableMermaid: true,
    enableTableResize: true,
    enableImageSelection: true,
    enableHistory: true,
    onChange,
    changeDebounceMs: 200,
  })
}
