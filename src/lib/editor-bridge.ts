import { loadDesktopMermaid } from './adapters/mermaid-loader'
import 'katex/dist/katex.min.css'
import {
  createEditor as coreCreateEditor,
  setDocumentBaseDir,
  type MediaResolver,
  type MorayaEditorInstance,
} from '@moraya/core'
import { tauriMediaResolver } from './adapters/tauri-media-resolver'
import { tauriLinkOpener } from './adapters/tauri-link-opener'
import { rendererRegistry } from './adapters/renderer-registry'
import { spreadsheetFactory } from './adapters/spreadsheet-factory'
import { frontmatterFactory, readonlyFrontmatterFactory } from './frontmatter-view'
import { activeTab } from './tabs.svelte'
import { analyticsPluginForEditor, recordEditorDelta } from './insights/tracker.svelte'
import type { Plugin } from 'prosemirror-state'
import type { Tab } from './tabs.svelte'
import { fileEditorSession, registerFileEditorSession } from './file-editor-sessions'

export interface DesktopFileMount {
  tab: Pick<Tab, 'id' | 'filePath' | 'currentContent' | 'mode'>
  plugins: Plugin[]
}
import { isApplePlatformSync } from './platform-sync'
import { guardRichEditor, type ImeGuard } from './ime'
import { ensureMermaidCssStyleSheetCompatibility } from './mermaid-cssom'

const platform = {
  getCurrentFilePath: () => activeTab()?.filePath ?? null,
  // Gates moraya-core's WKWebView workarounds; must not be hardcoded true or
  // they run under WebView2 too. See `isApplePlatformSync`.
  isMacOS: isApplePlatformSync(),
}

let requestedDocumentBaseDir = ''
let mountQueue: Promise<void> = Promise.resolve()
let mountInProgress = false

/** Update the base directory used to resolve relative image paths.
 *  Call whenever the active document's file path changes. */
export function updateDocumentBaseDir(filePath: string): void {
  if (filePath) {
    const sep = filePath.includes('\\') ? '\\' : '/'
    const lastSep = filePath.lastIndexOf(sep)
    const dir = lastSep > 0 ? filePath.slice(0, lastSep) : ''
    requestedDocumentBaseDir = dir
    // During an async createEditor call, a newly mounting surface may already
    // publish its path. The mount queue below reapplies each caller's captured
    // directory immediately before schema/editor creation, so do not disturb
    // the in-flight owner here.
    if (!mountInProgress) setDocumentBaseDir(dir)
  } else {
    import('@tauri-apps/api/path')
      .then(({ documentDir }) => documentDir())
      .then((dir) => {
        requestedDocumentBaseDir = dir
        if (!mountInProgress) setDocumentBaseDir(dir)
      })
      .catch(() => {
        requestedDocumentBaseDir = ''
        if (!mountInProgress) setDocumentBaseDir('')
      })
  }
}

/**
 * Mount a rich-text @moraya/core editor.
 *
 * `initialContent` is now an explicit parameter (was previously read from
 * tab.currentContent inside this function). This lets callers wrap content
 * in a fenced code block for code-kind tabs without coupling the bridge
 * to file-kind logic.
 *
 * The Editor Kit replicates the createEditor options below in
 * `src/editor-kit/rich.ts` (it cannot import this file: tabs / insights /
 * Tauri adapters have no IPC in a plugin webview). Keep the two in sync.
 */
export async function mountRichEditor(
  root: HTMLElement,
  initialContent: string,
  onChange: (md: string) => void,
  imeGuard?: ImeGuard,
  mediaResolver: MediaResolver = tauriMediaResolver,
  readOnly = false,
  file?: DesktopFileMount,
): Promise<MorayaEditorInstance> {
  const capturedBaseDir = requestedDocumentBaseDir
  const previousMount = mountQueue
  let releaseMount!: () => void
  mountQueue = new Promise<void>((resolve) => { releaseMount = resolve })
  await previousMount.catch(() => {})
  mountInProgress = true
  let instance: MorayaEditorInstance
  try {
    setDocumentBaseDir(capturedBaseDir)
    ensureMermaidCssStyleSheetCompatibility()
    if (file) {
      let session = fileEditorSession(file.tab.id)
      if (session) session.attach(root)
      else {
        const { mountFileEditor } = await import('../editor-kit-v2/file-main')
        session = await mountFileEditor(root, {
          file: { documentId: file.tab.filePath || file.tab.id, authority: crypto.randomUUID(), raw: file.tab.currentContent },
          readOnly,
          adapters: { mediaResolver, rendererRegistry, mermaidLoader: loadDesktopMermaid, linkOpener: tauriLinkOpener,
            platform: { ...platform, getCurrentFilePath: () => file.tab.filePath || null },
            spreadsheetViewFactory: spreadsheetFactory,
            frontmatterViewFactory: readOnly ? readonlyFrontmatterFactory : frontmatterFactory },
          render: { enableMath: true, enableMermaid: true, enableImageSelection: true },
        }, { plugins: file.plugins, onDelta: recordEditorDelta, externalSource: true, imeGuard })
        registerFileEditorSession(file.tab.id, session)
        await session.setMode(file.tab.mode)
      }
      session.owner.setReadOnly(readOnly)
      const mounted = session
      const unsubscribe = mounted.owner.observe(() => onChange(mounted.owner.snapshot().raw))
      return {
        view: mounted.view,
        getMarkdown: () => mounted.owner.snapshot().raw,
        setContent() { throw new Error('File content replacement requires owner admission') },
        destroy() { unsubscribe(); mounted.destroyView() },
      }
    }
    instance = await coreCreateEditor({
      container: root,
      initialContent,
      mediaResolver,
      rendererRegistry,
      linkOpener: tauriLinkOpener,
      platform,
      spreadsheetViewFactory: spreadsheetFactory,
      frontmatterViewFactory: readOnly ? readonlyFrontmatterFactory : frontmatterFactory,
      enableMath: true,
      enableMermaid: true,
      mermaidLoader: loadDesktopMermaid,
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
  } finally {
    mountInProgress = false
    releaseMount()
  }
  const plugin = analyticsPluginForEditor()
  instance.view.updateState(
    instance.view.state.reconfigure({
      plugins: instance.view.state.plugins.concat(plugin),
    }),
  )
  return guardRichEditor(root, instance, imeGuard)
}
