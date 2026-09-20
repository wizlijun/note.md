import type { InitializationResult, SaveCorrectionEntryResult, Snapshot } from './types'

export interface NotemdBridge {
  pluginId: string
  locale: string
  theme: string
  request(method: string, params?: unknown): Promise<any>
  onMessage(cb: (payload: unknown) => void): void
}

declare global {
  interface Window { notemd: NotemdBridge }
}

export function bridge(): NotemdBridge {
  if (!window.notemd) throw new Error('window.notemd bridge missing')
  return window.notemd
}

export const api = {
  initialize: (): Promise<InitializationResult> => bridge().request('plugin.initialize', {}),
  bootstrap: (): Promise<Snapshot> => bridge().request('plugin.bootstrap', {}),
  checkDataset: (input: string): Promise<unknown> => bridge().request('plugin.dataset_check', { input }),
  importDataset: (input: string): Promise<unknown> => bridge().request('plugin.dataset_import', { input }),
  deleteBatch: (run_id: string): Promise<unknown> => bridge().request('plugin.batch_delete', { run_id }),
  batchEvidence: (run_id: string, proposal_id: string): Promise<{ evidence: Array<Record<string, any>> }> => bridge().request('plugin.batch_evidence', { run_id, proposal_id }),
  commitBatch: (params: unknown): Promise<unknown> => bridge().request('plugin.batch_commit', params),
  normalizeFormalNames: (params: unknown): Promise<unknown> => bridge().request('plugin.normalize_formal_names', params),
  saveCorrectionEntry: (params: unknown): Promise<SaveCorrectionEntryResult> => bridge().request('plugin.save_correction_entry', params),
  deleteCorrectionEntry: (params: unknown): Promise<unknown> => bridge().request('plugin.delete_correction_entry', params),
  dictionaryPath: (): Promise<{ path: string }> => bridge().request('plugin.open_dictionary', {}),
  openInEditor: (path: string): Promise<void> => bridge().request('host.editor.open', { path }),
  toast: async (level: 'success' | 'info' | 'warn' | 'error', message: string, detail?: string) => {
    try { await bridge().request('host.toast', { level, message, detail }) } catch { /* feedback only */ }
  },
}
