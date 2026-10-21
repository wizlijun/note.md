import type { IncomingMessage } from './custom-editor-msg'

/** A file view acknowledges the exact text snapshot it receives. */
export interface FileViewOpen {
  type: 'file_view.open'
  uri: string
  content: string
  viewId: string
  requestId: number
  capabilities?: { edit: boolean }
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

export interface FileViewSave {
  type: 'file_view.save'
  requestId: number
  operationId: number
  content: string
}

export interface FileViewSaveResult {
  type: 'file_view.save_result'
  requestId: number
  operationId: number
  ok: boolean
  error?: string
}

export function validPageTarget(target: unknown): target is string {
  return typeof target === 'string' && target.trim().length > 0
    && target.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(target)
}

/** Writes are explicit requests; the host retains ownership and save admission. */
export function handleFileViewMessage(
  event: IncomingMessage,
  opts: {
    pluginOrigin: string
    expectedSource: unknown
    requestId: number
    onReady: () => void
    onFallback: (reason?: 'edit') => void
    onOpenPage?: (request: FileViewOpenPage) => void
    onSave?: (request: FileViewSave) => void
  },
): boolean {
  if (!opts.expectedSource || event.origin !== opts.pluginOrigin || event.source !== opts.expectedSource) return false
  const data = event.data as FileViewStatus | FileViewOpenPage | FileViewSave | undefined
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
  if (data.type === 'file_view.save' && Number.isSafeInteger(data.operationId)
    && data.operationId > 0 && typeof data.content === 'string' && opts.onSave) {
    opts.onSave(data)
    return true
  }
  return false
}
