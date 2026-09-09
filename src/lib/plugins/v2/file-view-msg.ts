import type { IncomingMessage } from './custom-editor-msg'

/** A read-only file view acknowledges the exact text snapshot it receives. */
export interface FileViewOpen {
  type: 'file_view.open'
  uri: string
  content: string
  viewId: string
  requestId: number
}

export type FileViewStatus =
  | { type: 'file_view.ready'; requestId: number }
  | { type: 'file_view.fallback'; requestId: number; reason?: 'edit' }

/** No `change` messages are accepted here: a display plugin never owns writes. */
export function handleFileViewMessage(
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
  const data = event.data as FileViewStatus | undefined
  if (!data || typeof data !== 'object' || data.requestId !== opts.requestId) return false
  if (data.type === 'file_view.ready') {
    opts.onReady()
    return true
  }
  if (data.type === 'file_view.fallback') {
    opts.onFallback(data.reason === 'edit' ? 'edit' : undefined)
    return true
  }
  return false
}
