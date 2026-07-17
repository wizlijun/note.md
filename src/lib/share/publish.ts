import { post } from './client'
import { generateSlug } from './slug'
import { getRecord, putRecord } from './records'
import { ShareError, type HtmlShareRecord } from './types'

export interface PublishHtmlInput {
  path: string
  filename: string
  html: string
  baseUrl: string
  defaultExpiry: 'never' | '7d' | '30d' | '90d'
  slugRandomSuffix: boolean
  /** Path of the source md relative to the vault root (e.g. `notes/foo.md`),
   *  identifying which local document this share represents. ALWAYS vault-relative
   *  — outside-vault files are vault-homed before publish — so audience stats
   *  attribute back to the md identically on every terminal. See
   *  {@link vaultRelativeSrc}. */
  src: string
}

/**
 * The `src` recorded for a share: the file's path relative to the vault root
 * (e.g. `notes/foo.md`). We only ever write a vault-relative src — every shared
 * file is vault-homed first (see prepareShareSrc), so a path that can't be made
 * relative is a bug, and we throw rather than persist an absolute path that other
 * terminals could never resolve.
 */
export function vaultRelativeSrc(absPath: string, vaultRoot: string | null): string {
  if (vaultRoot) {
    const root = vaultRoot.replace(/\/+$/, '')
    if (absPath !== root && absPath.startsWith(root + '/')) return absPath.slice(root.length + 1)
  }
  throw new ShareError('vault_required', absPath)
}

export interface PublishHtmlResult {
  url: string
  slug: string
  isUpdate: boolean
}

const EXPIRY_TO_SECONDS: Record<string, number | null> = {
  never: null,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
  '90d': 90 * 24 * 3600,
}

export async function publishHtml(input: PublishHtmlInput): Promise<PublishHtmlResult> {
  const prevRaw = getRecord(input.path)
  const prev: HtmlShareRecord | undefined =
    prevRaw && prevRaw.kind !== 'image' ? (prevRaw as HtmlShareRecord) : undefined
  const isUpdate = !!prev && !!prev.slug && !!prev.edit_token
  const slug = isUpdate ? prev!.slug : generateSlug(input.filename, input.html, input.slugRandomSuffix)
  const editToken = isUpdate ? prev!.edit_token : generateEditToken()
  const expiresInSeconds = EXPIRY_TO_SECONDS[input.defaultExpiry] ?? null

  // Retry on slug conflict for new shares only (max 3 attempts).
  let attempts = 0
  let currentSlug = slug
  while (true) {
    attempts++
    try {
      await post('/publish', {
        slug: currentSlug,
        edit_token: editToken,
        html: input.html,
        expires_in_seconds: expiresInSeconds,
        metadata: {
          original_filename: input.filename,
          source_ext: input.filename.split('.').pop() ?? '',
          src: input.src,
        },
      })
      break
    } catch (e) {
      if (e instanceof ShareError && e.kind === 'conflict' && !isUpdate && attempts < 3) {
        currentSlug = `${slug}-${attempts + 1}`
        continue
      }
      throw e
    }
  }

  const base = input.baseUrl.replace(/\/+$/, '')
  const shareUrl = `${base}/${currentSlug}`
  const now = new Date().toISOString()
  const expiresAt = expiresInSeconds == null
    ? null
    : new Date(Date.now() + expiresInSeconds * 1000).toISOString()
  await putRecord(input.path, {
    slug: currentSlug,
    edit_token: editToken,
    url: shareUrl,
    created_at: prev?.created_at ?? now,
    expires_at: expiresAt,
    filename: input.filename,
  })

  return { url: shareUrl, slug: currentSlug, isUpdate }
}

function generateEditToken(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
