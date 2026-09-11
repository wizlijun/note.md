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
  vault_configured: boolean
  credential_path: string
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

export type IntakePolicy = {
  sender_filter_enabled: boolean
  allowed_sender: string | null
  setup_expires_at: string | null
  updated_at: string
}

export type MailListItem = {
  source_id: string
  subject: string | null
  claimed_from: string | null
  envelope_from: string | null
  received_at: string | null
  status: string | null
  raw_available: boolean
}

export type MailPreview = {
  source_id: string
  subject: string | null
  claimed_from: string | null
  envelope_from: string | null
  to: string | null
  date: string | null
  message_id: string | null
  body_text: string
  body_html: string | null
  body_kind: 'text/plain' | 'text/html' | 'unavailable'
  links: string[]
  notice: string
}
