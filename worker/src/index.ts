export interface Env {
  SHARES: KVNamespace
  SHARE_API_KEY: string
}

const SLUG_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/
const TOKEN_RE = /^[a-zA-Z0-9]{16,128}$/
const MAX_HTML_BYTES = 25 * 1024 * 1024

interface PublishBody {
  slug: string
  edit_token: string
  html: string
  expires_in_seconds?: number
  metadata: { original_filename: string; source_ext: string }
}

interface KvMeta {
  edit_token: string
  created_at: string
  expires_at: string | null
  original_filename: string
  source_ext: string
  size_bytes: number
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

async function handlePublish(req: Request, env: Env, baseUrl: string): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  let body: PublishBody
  try {
    body = await req.json() as PublishBody
  } catch {
    return new Response('Bad JSON', { status: 400 })
  }
  if (!body || typeof body.slug !== 'string' || !SLUG_RE.test(body.slug)) {
    return new Response('Bad slug', { status: 400 })
  }
  if (!TOKEN_RE.test(body.edit_token ?? '')) return new Response('Bad edit_token', { status: 400 })
  if (typeof body.html !== 'string') return new Response('Bad html', { status: 400 })
  if (new TextEncoder().encode(body.html).byteLength > MAX_HTML_BYTES) {
    return new Response('Payload too large', { status: 413 })
  }

  const existing = await env.SHARES.getWithMetadata<KvMeta>(body.slug)
  let createdAt: string
  if (existing.value && existing.metadata) {
    if (existing.metadata.edit_token !== body.edit_token) {
      return new Response(JSON.stringify({ error: 'slug_conflict' }), { status: 409 })
    }
    createdAt = existing.metadata.created_at
  } else {
    createdAt = new Date().toISOString()
  }

  const expirationTtl = body.expires_in_seconds && body.expires_in_seconds > 60
    ? body.expires_in_seconds : undefined
  const expiresAt = expirationTtl
    ? new Date(Date.now() + expirationTtl * 1000).toISOString() : null

  const meta: KvMeta = {
    edit_token: body.edit_token,
    created_at: createdAt,
    expires_at: expiresAt,
    original_filename: body.metadata?.original_filename ?? '',
    source_ext: body.metadata?.source_ext ?? '',
    size_bytes: new TextEncoder().encode(body.html).byteLength,
  }
  await env.SHARES.put(body.slug, body.html, {
    metadata: meta,
    ...(expirationTtl ? { expirationTtl } : {}),
  })

  return new Response(JSON.stringify({
    slug: body.slug,
    edit_token: body.edit_token,
    url: `${baseUrl}/${body.slug}`,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleGet(slug: string, env: Env): Promise<Response> {
  if (!SLUG_RE.test(slug)) {
    return new Response(NOT_FOUND_HTML, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  const result = await env.SHARES.getWithMetadata<KvMeta>(slug)
  if (!result.value) {
    return new Response(NOT_FOUND_HTML, { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }
  return new Response(result.value, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=86400',
      'X-Robots-Tag': 'noindex',
    },
  })
}

async function handleDelete(slug: string, req: Request, env: Env): Promise<Response> {
  if (unauthorized(req, env)) return new Response('Unauthorized', { status: 401 })
  if (!SLUG_RE.test(slug)) return new Response('Bad slug', { status: 400 })
  let body: { edit_token?: string }
  try { body = await req.json() } catch { return new Response('Bad JSON', { status: 400 }) }
  if (!TOKEN_RE.test(body?.edit_token ?? '')) return new Response('Bad edit_token', { status: 400 })

  const existing = await env.SHARES.getWithMetadata<KvMeta>(slug)
  if (!existing.value || !existing.metadata) {
    return new Response('Not Found', { status: 404 })
  }
  if (existing.metadata.edit_token !== body.edit_token) {
    return new Response('Forbidden', { status: 403 })
  }
  await env.SHARES.delete(slug)
  return new Response(null, { status: 204 })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.slice(1)
    const baseUrl = `${url.protocol}//${url.host}`
    if (req.method === 'POST' && path === 'publish') return handlePublish(req, env, baseUrl)
    if (req.method === 'GET' && path) return handleGet(path, env)
    if (req.method === 'DELETE' && path) return handleDelete(path, req, env)
    return new Response('Not Found', { status: 404 })
  }
}
