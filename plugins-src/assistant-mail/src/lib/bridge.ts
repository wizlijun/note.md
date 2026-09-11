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

export function pluginRequest<T>(method: string, params?: unknown): Promise<T> {
  return bridge().request(`plugin.${method}`, params)
}

export type SettingsState = {
  worker_url: string | null
  key_configured: boolean
  key_fingerprint: string | null
  local_cursor: string | null
  archived_sources: number
  archived_raw: number
}

export type DeletePlan = {
  id: string
  plan_hash: string
  source_ids?: string[]
  [key: string]: unknown
}
