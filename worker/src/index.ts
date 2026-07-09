export interface Env {
  SHARES: KVNamespace
  MEDIA: R2Bucket
  SHARE_API_KEY: string
  AUDIENCE: DurableObjectNamespace
  AUDIENCE_DAY: DurableObjectNamespace
}

export { SlugAnalytics, DayRollup } from './audience'
import { SLUG_RE as AUDIENCE_SLUG_RE } from './audience'

const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/
const TOKEN_RE = /^[a-zA-Z0-9]{16,128}$/
const MAX_HTML_BYTES = 25 * 1024 * 1024
const MAX_MEDIA_BYTES = 50 * 1024 * 1024
const MIN_EXPIRES_IN = 60
const DEFAULT_EXPIRES_IN = 7 * 24 * 60 * 60   // 7 days

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
}

const FTYP_BRANDS: Record<string, RegExp> = {
  'video/mp4': /^(isom|iso2|mp41|mp42|avc1|m4v |dash|msnv)$/,
  'video/quicktime': /^qt {0,2}$/,
  'image/avif': /^(avif|avis|mif1)$/,
  'image/heic': /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/,
  'image/heif': /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis|heif)$/,
}

function startsWith(body: Uint8Array, pattern: number[]): boolean {
  if (body.length < pattern.length) return false
  for (let i = 0; i < pattern.length; i++) if (body[i] !== pattern[i]) return false
  return true
}

function matchesAt(body: Uint8Array, offset: number, ascii: string): boolean {
  if (body.length < offset + ascii.length) return false
  for (let i = 0; i < ascii.length; i++) {
    if (body[offset + i] !== ascii.charCodeAt(i)) return false
  }
  return true
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
function generateId(length = 12): string {
  const buf = new Uint8Array(length)
  crypto.getRandomValues(buf)
  let out = ''
  for (let i = 0; i < length; i++) out += ID_ALPHABET[buf[i] % ID_ALPHABET.length]
  return out
}

async function allocateMediaKey(env: Env, ext: string): Promise<{ id: string; key: string }> {
  for (let i = 0; i < 5; i++) {
    const id = generateId()
    const key = `f/${id}.${ext}`
    const head = await env.MEDIA.head(key)
    if (!head) return { id, key }
  }
  throw new Error('id_collision')
}

function magicOk(mime: string, body: Uint8Array): boolean {
  switch (mime) {
    case 'image/jpeg':
      return startsWith(body, [0xff, 0xd8, 0xff])
    case 'image/png':
      return startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/gif':
      return matchesAt(body, 0, 'GIF87a') || matchesAt(body, 0, 'GIF89a')
    case 'image/webp':
      return matchesAt(body, 0, 'RIFF') && matchesAt(body, 8, 'WEBP')
    case 'video/webm':
      return startsWith(body, [0x1a, 0x45, 0xdf, 0xa3])
    case 'image/svg+xml': {
      const head = new TextDecoder().decode(body.subarray(0, Math.min(body.length, 1024))).trimStart().toLowerCase()
      return head.startsWith('<?xml') ? head.includes('<svg') : head.startsWith('<svg')
    }
    case 'video/mp4':
    case 'video/quicktime':
    case 'image/avif':
    case 'image/heic':
    case 'image/heif': {
      if (!matchesAt(body, 4, 'ftyp')) return false
      const brand = new TextDecoder().decode(body.subarray(8, 12))
      return FTYP_BRANDS[mime].test(brand)
    }
  }
  return false
}

interface PublishBody {
  slug: string
  edit_token: string
  html: string
  expires_in_seconds?: number
  metadata: { original_filename: string; source_ext: string; src?: string }
}

interface KvMeta {
  edit_token: string
  created_at: string
  expires_at: string | null
  original_filename: string
  source_ext: string
  size_bytes: number
  /** Path of the source md relative to the owner's vault (e.g. `notes/foo.md`),
   *  or an absolute path if it lives outside the vault. Lets audience stats be
   *  attributed back to a local document. Empty for shares published before this
   *  field existed. */
  src?: string
}

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Link expired — M↓</title>
<style>body{font-family:system-ui,sans-serif;max-width:36em;margin:6em auto;padding:0 1em;color:#333}@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}}</style>
</head><body>
<h1>This share link doesn't exist or has expired.</h1>
<p><small>Powered by <a href="https://github.com/wizlijun/MdEditor">M↓</a>.</small></p>
</body></html>`

function unauthorized(req: Request, env: Env): boolean {
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return true
  return auth.slice('Bearer '.length) !== env.SHARE_API_KEY
}

// ── Core ops (shared by HTTP handlers and MCP tools) ─────────────────────────
type CoreOk<T> = { ok: true; data: T }
type CoreErr = { ok: false; status: number; code: string; message: string }
type CoreResult<T> = CoreOk<T> | CoreErr
const coreErr = (status: number, code: string, message: string): CoreErr =>
  ({ ok: false, status, code, message })

interface PublishArgs {
  slug?: unknown; edit_token?: unknown; html?: unknown
  expires_in_seconds?: unknown
  metadata?: { original_filename?: unknown; source_ext?: unknown; src?: unknown }
}

interface PublishResult {
  slug: string; edit_token: string; url: string; expires_at: string | null
}

async function publishHtmlCore(
  env: Env, args: PublishArgs, baseUrl: string,
): Promise<CoreResult<PublishResult>> {
  if (typeof args?.slug !== 'string' || !SLUG_RE.test(args.slug)) {
    return coreErr(400, 'bad_slug', 'slug must match YYYY-MM-DD-<lowercase-slug>[-<suffix>]')
  }
  if (typeof args.edit_token !== 'string' || !TOKEN_RE.test(args.edit_token)) {
    return coreErr(400, 'bad_edit_token', 'edit_token must be 16-128 chars [a-zA-Z0-9]')
  }
  if (typeof args.html !== 'string') {
    return coreErr(400, 'bad_html', 'html must be a string')
  }
  if (new TextEncoder().encode(args.html).byteLength > MAX_HTML_BYTES) {
    return coreErr(413, 'payload_too_large', `html exceeds ${MAX_HTML_BYTES} bytes`)
  }
  const slug = args.slug
  const editToken = args.edit_token
  const html = args.html

  const existing = await env.SHARES.getWithMetadata<KvMeta>(slug)
  let createdAt: string
  if (existing.value && existing.metadata) {
    if (existing.metadata.edit_token !== editToken) {
      return coreErr(409, 'slug_conflict', 'slug exists with different edit_token')
    }
    createdAt = existing.metadata.created_at
  } else {
    createdAt = new Date().toISOString()
  }

  const expiresInRaw = args.expires_in_seconds
  const expirationTtl = typeof expiresInRaw === 'number' && expiresInRaw >= MIN_EXPIRES_IN
    ? Math.floor(expiresInRaw)
    : DEFAULT_EXPIRES_IN
  const expiresAt = new Date(Date.now() + expirationTtl * 1000).toISOString()

  const meta: KvMeta = {
    edit_token: editToken,
    created_at: createdAt,
    expires_at: expiresAt,
    original_filename: typeof args.metadata?.original_filename === 'string' ? args.metadata.original_filename : '',
    source_ext: typeof args.metadata?.source_ext === 'string' ? args.metadata.source_ext : '',
    size_bytes: new TextEncoder().encode(html).byteLength,
    src: typeof args.metadata?.src === 'string' ? args.metadata.src : '',
  }
  await env.SHARES.put(slug, html, { metadata: meta, expirationTtl })

  return { ok: true, data: { slug, edit_token: editToken, url: `${baseUrl}/${slug}`, expires_at: expiresAt } }
}

interface GetShareResult {
  slug: string; html: string; expires_at: string | null
  created_at: string; original_filename: string; source_ext: string; size_bytes: number
}

async function getShareCore(env: Env, slug: string): Promise<CoreResult<GetShareResult>> {
  if (!SLUG_RE.test(slug)) return coreErr(404, 'not_found', 'slug not found')
  const result = await env.SHARES.getWithMetadata<KvMeta>(slug)
  if (!result.value || !result.metadata) return coreErr(404, 'not_found', 'slug not found')
  return {
    ok: true,
    data: {
      slug,
      html: result.value,
      expires_at: result.metadata.expires_at,
      created_at: result.metadata.created_at,
      original_filename: result.metadata.original_filename,
      source_ext: result.metadata.source_ext,
      size_bytes: result.metadata.size_bytes,
    },
  }
}

async function deleteShareCore(
  env: Env, slug: string, editToken: string,
): Promise<CoreResult<{ slug: string }>> {
  if (!SLUG_RE.test(slug)) return coreErr(400, 'bad_slug', 'invalid slug')
  if (!TOKEN_RE.test(editToken)) return coreErr(400, 'bad_edit_token', 'invalid edit_token')
  const existing = await env.SHARES.getWithMetadata<KvMeta>(slug)
  if (!existing.value || !existing.metadata) return coreErr(404, 'not_found', 'slug not found')
  if (existing.metadata.edit_token !== editToken) {
    return coreErr(403, 'forbidden', 'edit_token does not match')
  }
  await env.SHARES.delete(slug)
  return { ok: true, data: { slug } }
}

interface UploadArgs {
  content_type: string
  body: Uint8Array
  edit_token: string
  original_filename?: string
  expires_in_seconds?: number
}

interface UploadResult {
  id: string; ext: string; url: string; edit_token: string
  expires_at: string | null; size_bytes: number
}

async function uploadMediaCore(
  env: Env, args: UploadArgs, baseUrl: string,
): Promise<CoreResult<UploadResult>> {
  if (!TOKEN_RE.test(args.edit_token)) {
    return coreErr(400, 'bad_edit_token', 'edit_token must be 16-128 chars [a-zA-Z0-9]')
  }
  const contentType = args.content_type.split(';')[0].trim().toLowerCase()
  const ext = MIME_EXT[contentType]
  if (!ext) {
    return coreErr(415, 'unsupported_media_type', `content_type "${contentType}" not in whitelist`)
  }
  let expirationTtl: number = DEFAULT_EXPIRES_IN
  if (args.expires_in_seconds !== undefined) {
    const n = args.expires_in_seconds
    if (!Number.isFinite(n) || n < MIN_EXPIRES_IN) {
      return coreErr(400, 'bad_expires_in_seconds', `expires_in_seconds must be >= ${MIN_EXPIRES_IN}`)
    }
    expirationTtl = Math.floor(n)
  }
  if (args.body.byteLength > MAX_MEDIA_BYTES) {
    return coreErr(413, 'payload_too_large', `body exceeds ${MAX_MEDIA_BYTES} bytes`)
  }
  if (!magicOk(contentType, args.body)) {
    return coreErr(415, 'magic_mismatch', 'body bytes do not match declared content_type')
  }

  const expiresAt = new Date(Date.now() + expirationTtl * 1000).toISOString()
  const { id, key } = await allocateMediaKey(env, ext)
  await env.MEDIA.put(key, args.body, {
    httpMetadata: { contentType },
    customMetadata: {
      edit_token: args.edit_token,
      original_filename: encodeURIComponent(args.original_filename ?? ''),
      expires_at: expiresAt,
      size_bytes: String(args.body.byteLength),
    },
  })
  return {
    ok: true,
    data: {
      id, ext,
      url: `${baseUrl}/f/${id}.${ext}`,
      edit_token: args.edit_token,
      expires_at: expiresAt,
      size_bytes: args.body.byteLength,
    },
  }
}

interface MediaMeta {
  id: string; ext: string; url: string
  content_type: string; original_filename: string
  expires_at: string | null; size_bytes: number
}

async function getMediaMetaCore(
  env: Env, id: string, ext: string, baseUrl: string,
): Promise<CoreResult<MediaMeta>> {
  if (!/^[a-z0-9]{12}$/.test(id) || !ALLOWED_EXTS.has(ext)) {
    return coreErr(404, 'not_found', 'media not found')
  }
  const key = `f/${id}.${ext}`
  const head = await env.MEDIA.head(key)
  if (!head) return coreErr(404, 'not_found', 'media not found')
  const expiresAt = head.customMetadata?.expires_at || null
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await env.MEDIA.delete(key)
    return coreErr(404, 'not_found', 'media expired')
  }
  return {
    ok: true,
    data: {
      id, ext,
      url: `${baseUrl}/f/${id}.${ext}`,
      content_type: head.httpMetadata?.contentType ?? 'application/octet-stream',
      original_filename: decodeURIComponent(head.customMetadata?.original_filename ?? ''),
      expires_at: expiresAt,
      size_bytes: Number(head.customMetadata?.size_bytes ?? head.size),
    },
  }
}

async function deleteMediaCore(
  env: Env, id: string, ext: string, editToken: string,
): Promise<CoreResult<{ id: string; ext: string }>> {
  if (!/^[a-z0-9]{12}$/.test(id) || !ALLOWED_EXTS.has(ext)) {
    return coreErr(400, 'bad_path', 'invalid id or ext')
  }
  if (!TOKEN_RE.test(editToken)) return coreErr(400, 'bad_edit_token', 'invalid edit_token')
  const key = `f/${id}.${ext}`
  const head = await env.MEDIA.head(key)
  if (!head) return coreErr(404, 'not_found', 'media not found')
  if (head.customMetadata?.edit_token !== editToken) {
    return coreErr(403, 'forbidden', 'edit_token does not match')
  }
  await env.MEDIA.delete(key)
  return { ok: true, data: { id, ext } }
}

async function handlePublish(req: Request, env: Env, baseUrl: string): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  let body: PublishArgs
  try { body = await req.json() as PublishArgs } catch { return new Response('Bad JSON', { status: 400 }) }
  const r = await publishHtmlCore(env, body, baseUrl)
  if (!r.ok) {
    if (r.code === 'slug_conflict') {
      return new Response(JSON.stringify({ error: 'slug_conflict' }), { status: 409 })
    }
    return new Response(r.message, { status: r.status })
  }
  return new Response(JSON.stringify({ slug: r.data.slug, edit_token: r.data.edit_token, url: r.data.url }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleGet(slug: string, env: Env): Promise<Response> {
  const r = await getShareCore(env, slug)
  if (!r.ok) {
    return new Response(NOT_FOUND_HTML, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  return new Response(r.data.html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=86400',
      'X-Robots-Tag': 'noindex',
    },
  })
}

async function handleUpload(req: Request, env: Env, baseUrl: string): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })

  const editToken = req.headers.get('X-Edit-Token') ?? ''
  const contentType = req.headers.get('Content-Type') ?? ''
  const expiresHeader = req.headers.get('X-Expires-In')
  let expiresInSeconds: number | undefined
  if (expiresHeader !== null) {
    const n = Number(expiresHeader)
    if (!Number.isFinite(n)) return new Response('Bad X-Expires-In', { status: 400 })
    expiresInSeconds = n
  }
  const body = new Uint8Array(await req.arrayBuffer())
  const r = await uploadMediaCore(env, {
    content_type: contentType,
    body,
    edit_token: editToken,
    original_filename: req.headers.get('X-Filename') ?? '',
    expires_in_seconds: expiresInSeconds,
  }, baseUrl)
  if (!r.ok) return new Response(r.message, { status: r.status })
  return new Response(JSON.stringify(r.data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const MEDIA_PATH_RE = /^f\/([a-z0-9]{12})\.([a-z0-9]{2,4})$/
const ALLOWED_EXTS = new Set(Object.values(MIME_EXT))

function notFoundMedia(): Response {
  return new Response(NOT_FOUND_HTML, {
    status: 410,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  })
}

function parseRange(header: string, total: number): { offset: number; length: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!m) return null
  const a = m[1]
  const b = m[2]
  if (a === '' && b === '') return null
  if (a === '') {
    const suffix = Math.min(Number(b), total)
    return { offset: total - suffix, length: suffix }
  }
  const start = Number(a)
  const end = b === '' ? total - 1 : Math.min(Number(b), total - 1)
  if (start > end) return null
  return { offset: start, length: end - start + 1 }
}

function mediaResponseHeaders(contentType: string, ext: string, originalFilename: string): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Robots-Tag': 'noindex',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  }
  if (ext === 'svg') {
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    headers['Content-Disposition'] = originalFilename
      ? `inline; filename="${originalFilename.replace(/[^\w.\-]/g, '_')}"`
      : 'inline'
  }
  return headers
}

async function handleMediaGet(path: string, req: Request, env: Env): Promise<Response> {
  const m = MEDIA_PATH_RE.exec(path)
  if (!m || !ALLOWED_EXTS.has(m[2])) return notFoundMedia()
  const key = path

  const head = await env.MEDIA.head(key)
  if (!head) return notFoundMedia()

  const expiresAt = head.customMetadata?.expires_at ?? ''
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    await env.MEDIA.delete(key)
    return notFoundMedia()
  }

  const total = head.size
  const contentType = head.httpMetadata?.contentType ?? 'application/octet-stream'
  const ext = m[2]
  const originalFilename = decodeURIComponent(head.customMetadata?.original_filename ?? '')

  const rangeHeader = req.headers.get('Range')
  if (rangeHeader) {
    const range = parseRange(rangeHeader, total)
    if (!range) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${total}` },
      })
    }
    const obj = await env.MEDIA.get(key, { range: { offset: range.offset, length: range.length } })
    if (!obj) return notFoundMedia()
    const buf = await obj.arrayBuffer()
    return new Response(buf, {
      status: 206,
      headers: {
        ...mediaResponseHeaders(contentType, ext, originalFilename),
        'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${total}`,
        'Content-Length': String(range.length),
      },
    })
  }

  const obj = await env.MEDIA.get(key)
  if (!obj) return notFoundMedia()
  const buf = await obj.arrayBuffer()
  return new Response(buf, {
    status: 200,
    headers: {
      ...mediaResponseHeaders(contentType, ext, originalFilename),
      'Content-Length': String(total),
    },
  })
}

async function handleMediaDelete(path: string, req: Request, env: Env): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  const m = MEDIA_PATH_RE.exec(path)
  if (!m) return new Response('Bad path', { status: 400 })
  let body: { edit_token?: string }
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }
  const r = await deleteMediaCore(env, m[1], m[2], body?.edit_token ?? '')
  if (!r.ok) return new Response(r.message, { status: r.status })
  return new Response(null, { status: 204 })
}

async function handleDelete(slug: string, req: Request, env: Env): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  let body: { edit_token?: string }
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }
  const r = await deleteShareCore(env, slug, body?.edit_token ?? '')
  if (!r.ok) return new Response(r.message, { status: r.status })
  return new Response(null, { status: 204 })
}

// ── MCP tool catalog (defined below the framework) ───────────────────────────
interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const SUPPORTED_MIME_LIST = Object.keys(MIME_EXT)

const MCP_TOOLS: McpTool[] = [
  {
    name: 'share_publish_html',
    description:
      'Publish a self-contained HTML document at a chosen slug, returning a public URL. ' +
      'Use this for sharing rendered markdown, articles, slides, or any standalone HTML page. ' +
      'The slug must follow the pattern YYYY-MM-DD-<lowercase-slug>[-<2-4 char suffix>], ' +
      'e.g. "2026-05-08-trip-notes-x7k". Republishing the same slug REQUIRES the same edit_token; ' +
      'using a different token returns slug_conflict. Generate edit_token once (16-128 chars [a-zA-Z0-9], ' +
      'cryptographically random) and persist it locally — without it you cannot update or delete the share. ' +
      'HTML body capped at 25 MB. Default lifetime is 7 days; pass expires_in_seconds (>=60) to override.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', description: 'YYYY-MM-DD-<slug>[-<suffix>]', pattern: '^\\d{4}-\\d{2}-\\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$' },
        edit_token: { type: 'string', description: '16-128 chars [a-zA-Z0-9]; required to update or delete this share later', minLength: 16, maxLength: 128 },
        html: { type: 'string', description: 'Self-contained HTML (≤ 25 MB UTF-8 bytes)' },
        expires_in_seconds: { type: 'integer', description: 'Optional; >=60. Default 604800 (7 days) when omitted.', minimum: 60 },
        original_filename: { type: 'string', description: 'Optional; for display only' },
        source_ext: { type: 'string', description: 'Optional; original source extension, e.g. "md"' },
      },
      required: ['slug', 'edit_token', 'html'],
    },
  },
  {
    name: 'share_get_html',
    description:
      'Fetch a published share by slug. Returns the HTML body and metadata (created_at, expires_at, ' +
      'original_filename, source_ext, size_bytes). Public — no edit_token needed. Returns isError ' +
      'if the slug is unknown or already expired.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'share_delete',
    description:
      'Delete a published HTML share. The edit_token must match the one used at publish time, ' +
      'otherwise the call fails with forbidden. Idempotent only after success — calling again returns not_found.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        slug: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$' },
        edit_token: { type: 'string', minLength: 16, maxLength: 128 },
      },
      required: ['slug', 'edit_token'],
    },
  },
  {
    name: 'share_upload_media',
    description:
      'Upload an image or short video and receive a public URL suitable for <img src> or <video src>. ' +
      'The body bytes must be base64-encoded in body_base64. Maximum 50 MB AFTER decoding. ' +
      'For files larger than ~30 MB prefer the HTTP endpoint POST /upload (raw bytes, no base64) ' +
      'because base64 inflates the JSON-RPC payload by ~33%. ' +
      'Supported content_type values: ' + SUPPORTED_MIME_LIST.join(', ') + '. ' +
      'Magic-byte sniffing rejects mismatched content (e.g. HTML disguised as image/png). ' +
      'Generate edit_token once (16-128 chars [a-zA-Z0-9], cryptographically random) and persist it — ' +
      'it is required to delete the file later. ' +
      'Default lifetime is 7 days; pass expires_in_seconds (>=60) to override. ' +
      'After upload, embed the url in HTML and call share_publish_html.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        content_type: { type: 'string', enum: SUPPORTED_MIME_LIST, description: 'MIME type of the file being uploaded' },
        body_base64: { type: 'string', description: 'File bytes, base64-encoded (standard alphabet, with or without padding)' },
        edit_token: { type: 'string', description: '16-128 chars [a-zA-Z0-9]; required to delete this file later', minLength: 16, maxLength: 128 },
        original_filename: { type: 'string', description: 'Optional; for display in Content-Disposition' },
        expires_in_seconds: { type: 'integer', description: 'Optional; >=60. Default 604800 (7 days) when omitted.', minimum: 60 },
      },
      required: ['content_type', 'body_base64', 'edit_token'],
    },
  },
  {
    name: 'share_get_media_meta',
    description:
      'Look up metadata (URL, content_type, size, original_filename, expires_at) for a previously uploaded ' +
      'media file by id and ext. Does NOT return the binary. Use the returned url to embed or download. ' +
      'Returns isError if the file does not exist or has expired (expired files are lazily deleted on this call).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9]{12}$', description: 'The 12-char id returned from share_upload_media' },
        ext: { type: 'string', enum: Array.from(new Set(Object.values(MIME_EXT))) },
      },
      required: ['id', 'ext'],
    },
  },
  {
    name: 'share_delete_media',
    description:
      'Delete a previously uploaded media file. The edit_token must match the one used at upload time. ' +
      'Once deleted, the URL returns 410 and cannot be recovered.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9]{12}$' },
        ext: { type: 'string', enum: Array.from(new Set(Object.values(MIME_EXT))) },
        edit_token: { type: 'string', minLength: 16, maxLength: 128 },
      },
      required: ['id', 'ext', 'edit_token'],
    },
  },
]

async function mcpCallTool(
  req: Request, id: JsonRpcId, params: unknown, env: Env, baseUrl: string,
): Promise<Response> {
  if (!params || typeof params !== 'object') {
    return rpcErr(req, id, -32602, 'Invalid params: expected object')
  }
  const p = params as { name?: unknown; arguments?: unknown }
  if (typeof p.name !== 'string') {
    return rpcErr(req, id, -32602, 'Invalid params: name must be a string')
  }
  const args = (p.arguments && typeof p.arguments === 'object') ? p.arguments as Record<string, unknown> : {}
  const tool = MCP_TOOL_HANDLERS[p.name]
  if (!tool) return rpcErr(req, id, -32602, `Unknown tool: ${p.name}`)
  try {
    const result = await tool(args, env, baseUrl)
    return rpcOk(req, id, result)
  } catch (e) {
    return rpcErr(req, id, -32603, 'Internal error', { message: (e as Error).message })
  }
}

interface ToolContent { type: 'text'; text: string }
interface ToolCallResult { content: ToolContent[]; isError?: boolean }
type McpToolHandler = (args: Record<string, unknown>, env: Env, baseUrl: string) => Promise<ToolCallResult>

function toolOk(data: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}
function toolError(code: string, message: string): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: code, message }, null, 2) }], isError: true }
}
function toolErrorFromCore(err: CoreErr): ToolCallResult {
  return toolError(err.code, err.message)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function asInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.floor(v) !== v) return null
  return v
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.replace(/\s+/g, ''))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

const MCP_TOOL_HANDLERS: Record<string, McpToolHandler> = {
  async share_publish_html(args, env, baseUrl) {
    const slug = asString(args.slug)
    const editToken = asString(args.edit_token)
    const html = asString(args.html)
    if (!slug || !editToken || html === null) {
      return toolError('bad_args', 'slug, edit_token, html are required strings')
    }
    const expiresIn = args.expires_in_seconds === undefined ? undefined : asInt(args.expires_in_seconds) ?? -1
    if (expiresIn !== undefined && expiresIn < 0) {
      return toolError('bad_args', 'expires_in_seconds must be an integer')
    }
    const r = await publishHtmlCore(env, {
      slug, edit_token: editToken, html,
      expires_in_seconds: expiresIn,
      metadata: {
        original_filename: asString(args.original_filename) ?? '',
        source_ext: asString(args.source_ext) ?? '',
      },
    }, baseUrl)
    return r.ok ? toolOk(r.data) : toolErrorFromCore(r)
  },

  async share_get_html(args, env) {
    const slug = asString(args.slug)
    if (!slug) return toolError('bad_args', 'slug is required')
    const r = await getShareCore(env, slug)
    return r.ok ? toolOk(r.data) : toolErrorFromCore(r)
  },

  async share_delete(args, env) {
    const slug = asString(args.slug)
    const editToken = asString(args.edit_token)
    if (!slug || !editToken) return toolError('bad_args', 'slug and edit_token are required')
    const r = await deleteShareCore(env, slug, editToken)
    return r.ok ? toolOk(r.data) : toolErrorFromCore(r)
  },

  async share_upload_media(args, env, baseUrl) {
    const contentType = asString(args.content_type)
    const b64 = asString(args.body_base64)
    const editToken = asString(args.edit_token)
    if (!contentType || !b64 || !editToken) {
      return toolError('bad_args', 'content_type, body_base64, edit_token are required')
    }
    const body = base64ToBytes(b64)
    if (!body) return toolError('bad_base64', 'body_base64 is not valid base64')
    const expiresIn = args.expires_in_seconds === undefined ? undefined : asInt(args.expires_in_seconds) ?? -1
    if (expiresIn !== undefined && expiresIn < 0) {
      return toolError('bad_args', 'expires_in_seconds must be an integer')
    }
    const r = await uploadMediaCore(env, {
      content_type: contentType, body, edit_token: editToken,
      original_filename: asString(args.original_filename) ?? undefined,
      expires_in_seconds: expiresIn,
    }, baseUrl)
    return r.ok ? toolOk(r.data) : toolErrorFromCore(r)
  },

  async share_get_media_meta(args, env, baseUrl) {
    const id = asString(args.id)
    const ext = asString(args.ext)
    if (!id || !ext) return toolError('bad_args', 'id and ext are required')
    const r = await getMediaMetaCore(env, id, ext, baseUrl)
    return r.ok ? toolOk(r.data) : toolErrorFromCore(r)
  },

  async share_delete_media(args, env) {
    const id = asString(args.id)
    const ext = asString(args.ext)
    const editToken = asString(args.edit_token)
    if (!id || !ext || !editToken) return toolError('bad_args', 'id, ext, edit_token are required')
    const r = await deleteMediaCore(env, id, ext, editToken)
    return r.ok ? toolOk(r.data) : toolErrorFromCore(r)
  },
}

// ── MCP (JSON-RPC 2.0; Streamable HTTP on /mcp) ──────────────────────────────
// Supports both the 2024-11-05 (POST-only JSON) and 2025-03-26 / 2025-06-18
// (Streamable HTTP with SSE) transport profiles, negotiated per request.
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18']
const LATEST_PROTOCOL_VERSION = '2025-06-18'
const MCP_SERVER_NAME = 'mdeditor-share'
const MCP_SERVER_VERSION = '0.3.0'

type JsonRpcId = number | string | null
interface JsonRpcRequest { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown }

function negotiateProtocolVersion(client: unknown): string {
  return typeof client === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(client)
    ? client
    : LATEST_PROTOCOL_VERSION
}

function wantsEventStream(req: Request): boolean {
  const accept = req.headers.get('Accept') ?? ''
  return accept.toLowerCase().includes('text/event-stream')
}

function sseEncode(body: unknown): Uint8Array {
  return new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
}

function sseSingleShot(body: unknown): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseEncode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
    },
  })
}

function jsonRpcEnvelope(id: JsonRpcId, result: unknown): object {
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcErrorEnvelope(id: JsonRpcId, code: number, message: string, data?: unknown): object {
  const err: { code: number; message: string; data?: unknown } = { code, message }
  if (data !== undefined) err.data = data
  return { jsonrpc: '2.0', id, error: err }
}

function rpcRespond(req: Request, body: object): Response {
  if (wantsEventStream(req)) return sseSingleShot(body)
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function rpcOk(req: Request, id: JsonRpcId, result: unknown): Response {
  return rpcRespond(req, jsonRpcEnvelope(id, result))
}

function rpcErr(req: Request, id: JsonRpcId, code: number, message: string, data?: unknown): Response {
  return rpcRespond(req, jsonRpcErrorEnvelope(id, code, message, data))
}

async function handleMcp(req: Request, env: Env, baseUrl: string): Promise<Response> {
  // Per MCP Streamable HTTP spec: servers that do NOT push server-initiated
  // messages MAY return 405 to GET, telling the client not to open a stream.
  // All tools here are synchronous request/response, so we decline GET.
  if (req.method === 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, DELETE' } })
  }
  if (req.method === 'DELETE') return new Response(null, { status: 204 })
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST, DELETE' } })
  }
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })

  let raw: string
  try { raw = await req.text() } catch { return rpcErr(req, null, -32700, 'Parse error') }
  let msg: JsonRpcRequest
  try {
    msg = JSON.parse(raw) as JsonRpcRequest
  } catch {
    return rpcErr(req, null, -32700, 'Parse error')
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcErr(req, msg?.id ?? null, -32600, 'Invalid Request')
  }
  const id = msg.id ?? null

  switch (msg.method) {
    case 'initialize': {
      const params = (msg.params && typeof msg.params === 'object') ? msg.params as { protocolVersion?: unknown } : {}
      return rpcOk(req, id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      })
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return new Response(null, { status: 204 })
    case 'ping':
      return rpcOk(req, id, {})
    case 'tools/list':
      return rpcOk(req, id, { tools: MCP_TOOLS })
    case 'tools/call':
      return mcpCallTool(req, id, msg.params, env, baseUrl)
    default:
      return rpcErr(req, id, -32601, `Method not found: ${msg.method}`)
  }
}

/**
 * Attach each slug's recorded `src` (the source md's vault-relative or absolute
 * path, from KV metadata) to a stats map, so the client can attribute audience
 * data back to a local document. Best-effort — slugs with no/expired metadata
 * are simply left without a src.
 */
async function attachSrc(env: Env, map: Record<string, { src?: string }>): Promise<void> {
  await Promise.all(Object.keys(map).map(async (slug) => {
    try {
      const meta = (await env.SHARES.getWithMetadata<KvMeta>(slug)).metadata
      if (meta?.src) map[slug].src = meta.src
    } catch { /* best-effort */ }
  }))
}

async function handleAudienceStats(req: Request, env: Env, url: URL): Promise<Response> {
  const slug = url.searchParams.get('slug') ?? ''
  if (!AUDIENCE_SLUG_RE.test(slug)) return new Response('bad slug', { status: 400 })
  // Authenticated by the author's share API key (same key used to publish), not
  // per-share edit_token — the key holder owns all their shares' stats.
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  const stub = env.AUDIENCE.get(env.AUDIENCE.idFromName(slug))
  const doUrl = new URL('https://do/stats')
  doUrl.search = url.search
  const stats = (await (await stub.fetch(doUrl.toString())).json()) as { src?: string }
  const meta = (await env.SHARES.getWithMetadata<KvMeta>(slug)).metadata
  if (meta?.src) stats.src = meta.src
  return Response.json(stats)
}

/**
 * Batch audience stats: authenticate once with the share API key, fan out to
 * each slug's Durable Object in parallel, return a `{ slug: stats }` map.
 * Body: `{ slugs: string[], from?: number, to?: number }` (epoch ms).
 */
async function handleAudienceStatsBatch(req: Request, env: Env): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  let body: { slugs?: unknown; from?: unknown; to?: unknown }
  try { body = await req.json() } catch { return new Response('bad json', { status: 400 }) }
  const slugs = Array.isArray(body.slugs)
    ? [...new Set(body.slugs.filter((s): s is string => typeof s === 'string' && AUDIENCE_SLUG_RE.test(s)))].slice(0, 500)
    : []
  const qs = new URLSearchParams()
  if (typeof body.from === 'number' && isFinite(body.from)) qs.set('from', String(body.from))
  if (typeof body.to === 'number' && isFinite(body.to)) qs.set('to', String(body.to))
  const search = qs.toString()
  const entries = await Promise.all(slugs.map(async (slug) => {
    const stub = env.AUDIENCE.get(env.AUDIENCE.idFromName(slug))
    const res = await stub.fetch(`https://do/stats${search ? '?' + search : ''}`)
    return [slug, await res.json()] as const
  }))
  const map = Object.fromEntries(entries) as Record<string, { src?: string }>
  await attachSrc(env, map)
  return Response.json(map)
}

/**
 * One-time backfill: migrate the given slugs' existing per-slug DO data into the
 * per-day rollup DOs (so /a/stats-all covers history). Idempotent (/set
 * overwrites). Share-API-key auth.
 */
async function handleAudienceBackfill(req: Request, env: Env): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  let body: { slugs?: unknown }
  try { body = await req.json() } catch { return new Response('bad json', { status: 400 }) }
  const slugs = Array.isArray(body.slugs)
    ? [...new Set(body.slugs.filter((s): s is string => typeof s === 'string' && AUDIENCE_SLUG_RE.test(s)))].slice(0, 5000)
    : []
  let dayWrites = 0
  await Promise.all(slugs.map(async (slug) => {
    const stub = env.AUDIENCE.get(env.AUDIENCE.idFromName(slug))
    const exp = (await (await stub.fetch('https://do/export')).json()) as Record<string, { ms: number; visitors: string[] }>
    await Promise.all(Object.entries(exp).map(async ([day, { ms, visitors }]) => {
      const dayDo = env.AUDIENCE_DAY.get(env.AUDIENCE_DAY.idFromName(`day:${day}`))
      await dayDo.fetch('https://day/set', { method: 'POST', body: JSON.stringify({ slug, ms, visitors }) })
      dayWrites++
    }))
  }))
  return Response.json({ ok: true, slugs: slugs.length, day_writes: dayWrites })
}

/** UTC day strings 'YYYY-MM-DD' for the inclusive [from, to] epoch-ms range. */
function daysInRange(from: number, to: number, cap = 400): string[] {
  const day = 86_400_000
  const start = Math.floor(from / day)
  const end = Math.floor(to / day)
  const out: string[] = []
  for (let d = start; d <= end && out.length < cap; d++) {
    out.push(new Date(d * day).toISOString().slice(0, 10))
  }
  return out
}

/**
 * ALL shares' audience stats for a DATE RANGE in one request, WITHOUT a slug
 * list. Reads only the per-day rollup DOs in the range (O(days)), so it stays
 * fast regardless of how many shares exist. Defaults to the last 30 days.
 * Returns `{ slug: { total_ms, unique_readers, days } }`. Share-API-key auth.
 */
async function handleAudienceStatsAll(req: Request, env: Env, url: URL): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  const now = Date.now()
  const to = Number(url.searchParams.get('to')) || now
  const from = Number(url.searchParams.get('from')) || to - 30 * 86_400_000
  const days = daysInRange(from, to)

  // Read each day's rollup in parallel, then merge per slug.
  const perDay = await Promise.all(days.map(async (day) => {
    const dayDo = env.AUDIENCE_DAY.get(env.AUDIENCE_DAY.idFromName(`day:${day}`))
    const data = (await (await dayDo.fetch('https://day/day')).json()) as Record<string, { ms: number; visitors: string[] }>
    return [day, data] as const
  }))

  const merged: Record<string, { total_ms: number; unique_readers: number; days: Record<string, number>; _visitors: Set<string> }> = {}
  for (const [day, data] of perDay) {
    for (const [slug, { ms, visitors }] of Object.entries(data)) {
      const m = (merged[slug] ??= { total_ms: 0, unique_readers: 0, days: {}, _visitors: new Set<string>() })
      m.total_ms += ms
      if (ms > 0) m.days[day] = (m.days[day] ?? 0) + ms
      for (const v of visitors) m._visitors.add(v)
    }
  }
  const out: Record<string, { total_ms: number; unique_readers: number; days: Record<string, number>; src?: string }> = {}
  for (const [slug, m] of Object.entries(merged)) {
    out[slug] = { total_ms: m.total_ms, unique_readers: m._visitors.size, days: m.days }
  }
  await attachSrc(env, out)
  return Response.json(out)
}

async function handleAudienceHit(req: Request, env: Env): Promise<Response> {
  let body: { slug?: unknown }
  try { body = await req.json() } catch { return new Response('bad json', { status: 400 }) }
  const slug = typeof body.slug === 'string' ? body.slug : ''
  if (!AUDIENCE_SLUG_RE.test(slug)) return new Response('bad slug', { status: 400 })
  const stub = env.AUDIENCE.get(env.AUDIENCE.idFromName(slug))
  return stub.fetch('https://do/hit', { method: 'POST', body: JSON.stringify(body) })
}

// The audience API is called cross-origin from the app's WKWebView (and from
// the shared page's beacon), so its responses must carry CORS headers and the
// endpoints must answer the preflight. `*` is safe: access is gated by the
// Authorization header (API key), not cookies/credentials.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Max-Age': '86400',
}

function withCors(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.slice(1)
    const baseUrl = `${url.protocol}//${url.host}`
    if (path === 'mcp') return handleMcp(req, env, baseUrl)
    // Audience analytics: CORS-enabled (cross-origin from the app webview).
    if (path.startsWith('a/')) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
      let res: Response
      if (req.method === 'POST' && path === 'a/hit') res = await handleAudienceHit(req, env)
      else if (req.method === 'POST' && path === 'a/stats-batch') res = await handleAudienceStatsBatch(req, env)
      else if (req.method === 'GET' && path === 'a/stats-all') res = await handleAudienceStatsAll(req, env, url)
      else if (req.method === 'POST' && path === 'a/backfill') res = await handleAudienceBackfill(req, env)
      else if (req.method === 'GET' && path === 'a/stats') res = await handleAudienceStats(req, env, url)
      else res = new Response('Not Found', { status: 404 })
      return withCors(res)
    }
    if (req.method === 'POST' && path === 'publish') return handlePublish(req, env, baseUrl)
    if (req.method === 'POST' && path === 'upload') return handleUpload(req, env, baseUrl)
    if (req.method === 'GET' && path.startsWith('f/')) return handleMediaGet(path, req, env)
    if (req.method === 'DELETE' && path.startsWith('f/')) return handleMediaDelete(path, req, env)
    if (req.method === 'GET' && path) return handleGet(path, env)
    if (req.method === 'DELETE' && path) return handleDelete(path, req, env)
    return new Response('Not Found', { status: 404 })
  }
}
