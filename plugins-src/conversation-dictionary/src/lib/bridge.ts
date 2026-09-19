import type { Snapshot } from './types'

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
  bootstrap: (): Promise<Snapshot> => bridge().request('plugin.bootstrap', {}),
  createDictionary: (subject_id: string): Promise<unknown> => bridge().request('plugin.create_dictionary', { subject_id }),
  checkDataset: (input: string): Promise<unknown> => bridge().request('plugin.dataset_check', { input }),
  importDataset: (input: string): Promise<unknown> => bridge().request('plugin.dataset_import', { input }),
  batchEvidence: (run_id: string, proposal_id: string): Promise<{ evidence: Array<Record<string, any>> }> => bridge().request('plugin.batch_evidence', { run_id, proposal_id }),
  commitBatch: (params: unknown): Promise<unknown> => bridge().request('plugin.batch_commit', params),
  dictionaryPath: (): Promise<{ path: string }> => bridge().request('plugin.open_dictionary', {}),
  openInEditor: (path: string): Promise<void> => bridge().request('host.editor.open', { path }),
  toast: async (level: 'success' | 'info' | 'warn' | 'error', message: string, detail?: string) => {
    try { await bridge().request('host.toast', { level, message, detail }) } catch { /* feedback only */ }
  },
}
