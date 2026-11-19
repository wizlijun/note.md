export type FileInputBlockedReason = 'rich-composing' | 'source-composing' | 'source-pending' | 'annotation-pending'

// Give a delivered compositionend time to commit its final frame, but never
// leave a close/save action waiting indefinitely for a missing native event.
export const FILE_INPUT_WAIT_MS = 1500

const safeCodes = new Set([
  'rich-composing', 'source-composing', 'source-pending', 'annotation-pending',
  'stale-source', 'source-diff-limit', 'file-not-writable', 'file-rejected',
  'GUEST_INPUT_PENDING', 'composition-interrupted', 'detached-buffer', 'uncancelable-history',
])

export class FileInputBlockedError extends Error {
  readonly code: string
  constructor(readonly reason: FileInputBlockedReason, code: string = reason) {
    // Admission failures can contain arbitrary plugin errors. Keep diagnostics
    // to known codes rather than carrying document text into host reporting.
    const safeCode = safeCodes.has(code) ? code : reason
    super(safeCode)
    this.name = 'FileInputBlockedError'
    this.code = safeCode
  }
}
