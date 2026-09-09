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

export interface FileViewOpenPage {
  type: 'file_view.open_page'
  requestId: number
  operationId: number
  target: string
}

export interface FileViewPageResult {
  type: 'file_view.page_result'
  requestId: number
  operationId: number
  ok: boolean
  error?: string
}

export function validPageTarget(target: unknown): target is string {
  return typeof target === 'string' && target.trim().length > 0
    && target.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(target)
}

/** No `change` messages are accepted here: a display plugin never owns writes. */
export function handleFileViewMessage(
  event: IncomingMessage,
  opts: {
    pluginOrigin: string
    expectedSource: unknown
    requestId: number
    onReady: () => void
    onFallback: (reason?: 'edit') => void
    onOpenPage?: (request: FileViewOpenPage) => void
  },
): boolean {
  if (!opts.expectedSource || event.origin !== opts.pluginOrigin || event.source !== opts.expectedSource) return false
  const data = event.data as FileViewStatus | FileViewOpenPage | undefined
  if (!data || typeof data !== 'object' || data.requestId !== opts.requestId) return false
  if (data.type === 'file_view.ready') {
    opts.onReady()
    return true
  }
  if (data.type === 'file_view.fallback') {
    opts.onFallback(data.reason === 'edit' ? 'edit' : undefined)
    return true
  }
  if (data.type === 'file_view.open_page' && Number.isSafeInteger(data.operationId)
    && data.operationId > 0 && validPageTarget(data.target) && opts.onOpenPage) {
    opts.onOpenPage(data)
    return true
  }
  return false
}
