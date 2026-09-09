import type { FileViewRef } from './file-views'

export type FileViewFallbackReason = 'edit' | 'unsupported' | 'unavailable'

export interface FileViewSelection {
  /** undefined = automatic; null = Rich; FileViewRef = an explicit file view. */
  choice?: FileViewRef | null
  fallback?: { view: FileViewRef; reason: FileViewFallbackReason }
  attempt: number
}

const selections = $state<Record<string, FileViewSelection>>({})

export function fileViewSelection(tabId: string): FileViewSelection | undefined {
  return selections[tabId]
}

export function setFileViewSelection(tabId: string, value: FileViewSelection): void {
  selections[tabId] = value
}

export function resetFileViewSelection(tabId: string): void {
  delete selections[tabId]
}
