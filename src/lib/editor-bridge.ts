import { createEditor as coreCreateEditor, type MorayaEditorInstance } from '@moraya/core'
import { tauriMediaResolver } from './adapters/tauri-media-resolver'
import { tauriLinkOpener } from './adapters/tauri-link-opener'
import { emptyRendererRegistry } from './adapters/empty-renderer-registry'
import { activeTab, type Tab } from './tabs.svelte'

const platform = {
  getCurrentFilePath: () => activeTab()?.filePath ?? null,
  isMacOS: true,
}

export async function mountRichEditor(
  root: HTMLElement,
  tab: Tab,
  onChange: (md: string) => void,
): Promise<MorayaEditorInstance> {
  return coreCreateEditor({
    container: root,
    initialContent: tab.currentContent,
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
