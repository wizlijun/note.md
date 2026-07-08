import 'katex/dist/katex.min.css'
import { createEditor as coreCreateEditor, setDocumentBaseDir, type MorayaEditorInstance } from '@moraya/core'
import { tauriMediaResolver } from './adapters/tauri-media-resolver'
import { tauriLinkOpener } from './adapters/tauri-link-opener'
import { rendererRegistry } from './adapters/renderer-registry'
import { spreadsheetFactory } from './adapters/spreadsheet-factory'
import { frontmatterFactory } from './frontmatter-view'
import { activeTab } from './tabs.svelte'
import { isPluginEnabled } from './settings.svelte'
import { analyticsPluginForEditor } from './insights/tracker.svelte'

const platform = {
  getCurrentFilePath: () => activeTab()?.filePath ?? null,
  isMacOS: true,
}

/** Update the base directory used to resolve relative image paths.
 *  Call whenever the active document's file path changes. */
export function updateDocumentBaseDir(filePath: string): void {
  if (filePath) {
    const sep = filePath.includes('\\') ? '\\' : '/'
    const lastSep = filePath.lastIndexOf(sep)
    const dir = lastSep > 0 ? filePath.slice(0, lastSep) : ''
    setDocumentBaseDir(dir)
  } else {
    import('@tauri-apps/api/path')
      .then(({ documentDir }) => documentDir())
      .then(dir => setDocumentBaseDir(dir))
      .catch(() => setDocumentBaseDir(''))
  }
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
  const instance = await coreCreateEditor({
    container: root,
    initialContent,
    mediaResolver: tauriMediaResolver,
    rendererRegistry,
    linkOpener: tauriLinkOpener,
    platform,
    spreadsheetViewFactory: spreadsheetFactory,
    frontmatterViewFactory: frontmatterFactory,
    enableMath: true,
    enableMermaid: true,
    enableTableResize: true,
    enableImageSelection: true,
    enableHistory: true,
    // Do NOT auto-format inline markers as you type: `**`, `__`, `*`, `_`,
    // `` ` ``, `~~`, `^^`, `==` stay literal instead of collapsing into a mark
    // (and hiding their delimiters). The user controls formatting explicitly.
    enableInlineMarkInputRules: false,
    // Marks already parsed from a file still render; on the caret's line their
    // source delimiters are revealed (Live-Preview style) and re-render on exit.
    inlineSyntaxScope: 'line',
    onChange,
    changeDebounceMs: 200,
  })
  if (isPluginEnabled('reading-insights')) {
    const plugin = analyticsPluginForEditor()
    instance.view.updateState(
      instance.view.state.reconfigure({
        plugins: instance.view.state.plugins.concat(plugin),
      }),
    )
  }
  return instance
}
