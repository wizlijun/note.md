import type { CustomEditorOpen, IncomingMessage } from './custom-editor-msg'

/** Read-only Markdown views acknowledge the exact document snapshot. */
export interface MarkdownViewerOpen extends CustomEditorOpen {
  requestId: number
}

export type MarkdownViewerStatus =
  | { type: 'custom_editor.ready'; requestId: number }
  | { type: 'custom_editor.fallback'; requestId: number; reason?: 'edit' }

/** No `change` messages are accepted here: a display plugin never owns writes. */
export function handleMarkdownViewerMessage(
  event: IncomingMessage,
  opts: {
    pluginOrigin: string
    expectedSource: unknown
    requestId: number
    onReady: () => void
    onFallback: (reason?: 'edit') => void
  },
): boolean {
  if (!opts.expectedSource || event.origin !== opts.pluginOrigin || event.source !== opts.expectedSource) return false
  const data = event.data as MarkdownViewerStatus | undefined
  if (!data || typeof data !== 'object' || data.requestId !== opts.requestId) return false
  if (data.type === 'custom_editor.ready') {
    opts.onReady()
    return true
  }
  if (data.type === 'custom_editor.fallback') {
    opts.onFallback(data.reason === 'edit' ? 'edit' : undefined)
    return true
  }
  return false
}
