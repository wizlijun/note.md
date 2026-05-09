import { readFile } from '@tauri-apps/plugin-fs'
import { postBytes, del } from './client'
import { getRecord, putRecord } from './records'
import { ShareError, type ImageShareRecord } from './types'

export interface UploadImageInput {
  path: string
  filename: string
  baseUrl: string
  defaultExpiry: 'never' | '7d' | '30d' | '90d'
}
export interface UploadImageResult {
  url: string
  isUpdate: boolean
}

const MAX_IMAGE_BYTES = 50 * 1024 * 1024

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', avif: 'image/avif',
  heic: 'image/heic', heif: 'image/heif',
}
const EXPIRY_TO_SECONDS: Record<string, number | null> = {
  never: null, '7d': 7 * 86400, '30d': 30 * 86400, '90d': 90 * 86400,
}

export async function uploadImage(input: UploadImageInput): Promise<UploadImageResult> {
  const ext = (input.filename.split('.').pop() ?? '').toLowerCase()
  const mime = EXT_TO_MIME[ext]
  if (!mime) throw new ShareError('unsupported', `extension .${ext}`)

  const bytes = await readFile(input.path)
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new ShareError('too_large', `${bytes.byteLength} bytes`)

  const editToken = generateEditToken()
  const expSec = EXPIRY_TO_SECONDS[input.defaultExpiry] ?? null
  const headers: Record<string, string> = {
    'X-Edit-Token': editToken,
    'X-Filename': input.filename,
  }
  if (expSec !== null) headers['X-Expires-In'] = String(expSec)

  const resp = await postBytes('/upload', bytes, mime, headers)
  const id = resp.id ?? ''
  const respExt = resp.ext ?? ext
  const url = resp.url ?? ''
  const expiresAt = resp.expires_at ?? null
  const sizeBytes = typeof resp.size_bytes === 'number' ? resp.size_bytes : bytes.byteLength

  // Best-effort delete of prior image
  const prev = getRecord(input.path) as ImageShareRecord | undefined
  const isUpdate = !!prev && prev.kind === 'image'
  if (isUpdate && prev.id && prev.ext && prev.edit_token) {
    try { await del(`/f/${prev.id}.${prev.ext}`, { edit_token: prev.edit_token }) }
    catch { /* swallow */ }
  }

  await putRecord(input.path, {
    kind: 'image',
    id, ext: respExt, edit_token: editToken, url,
    created_at: new Date().toISOString(),
    expires_at: expiresAt,
    filename: input.filename,
    size_bytes: sizeBytes,
  })

  return { url, isUpdate }
}

function generateEditToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
