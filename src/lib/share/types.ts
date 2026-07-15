export type ShareErrorKind =
  | 'not_configured'   // baseUrl or apiKey missing
  | 'vault_required'   // sharing an outside-vault file with no vault configured
  | 'no_path'          // tab unsaved
  | 'empty_content'    // no rendered html
  | 'network'          // fetch threw
  | 'auth'             // 401
  | 'forbidden'        // 403 (edit_token mismatch)
  | 'too_large'        // 413
  | 'conflict'         // 409 after retries
  | 'unsupported'      // 415 (image mime)
  | 'server'           // 5xx
  | 'http'             // other non-OK
  | 'parse'            // response not JSON
  | 'corrupt_record'   // local share.records broken

export class ShareError extends Error {
  constructor(public kind: ShareErrorKind, public detail?: string) {
    super(kind)
    this.name = 'ShareError'
  }
}

export interface HtmlShareRecord {
  kind?: 'html'   // legacy records have no kind; treat absence as html
  slug: string
  edit_token: string
  url: string
  created_at: string
  expires_at: string | null
  filename: string
}

export interface ImageShareRecord {
  kind: 'image'
  id: string
  ext: string
  edit_token: string
  url: string
  created_at: string
  expires_at: string | null
  filename: string
  size_bytes: number
}

export type ShareRecord = HtmlShareRecord | ImageShareRecord

export interface ShareSettings {
  baseUrl?: string
  apiKey?: string
  defaultExpiry?: 'never' | '7d' | '30d' | '90d'
  slugRandomSuffix?: boolean
}
