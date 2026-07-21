// notemd-plugins registry worker (子项目③ Task 4).
//
// Three public, unauthenticated endpoints — the whole surface the note.md
// plugin marketplace client (src-tauri/src/plugin_runtime/market.rs) talks to:
//
//   GET  /api/index.json                                → KV key `index` verbatim
//   GET  /api/download/<id>/<version>/<arch>[.minisig]  → R2 object stream
//   POST /api/stats/install  {id,version}               → bump KV `stats:<id>`, always 200
//
// Everything is public: packages are minisign-signed and sha256-pinned in the
// index, so integrity is verified client-side — there is no secret to protect
// on read. `*` CORS is therefore safe (no cookies/credentials involved).
//
// It also serves a human-facing landing page at `GET /` (and `/index.html`) —
// the marketplace homepage that renders the plugin list client-side from
// `/api/index.json`. See src/page.ts.

import { PAGE_HTML } from './page'

export interface Env {
  /** KV: `index` → the published index.json string; `stats:<id>` → install count. */
  INDEX: KVNamespace
  /** R2: `<id>/<version>/<arch>.notemdpkg` packages + `.minisig` siblings. */
  PKGS: R2Bucket
}

// `*` is safe: read access is unauthenticated by design and no credentials are
// sent, so there is nothing for a cross-origin caller to steal.
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
}

const EMPTY_INDEX = '{"plugins":[]}'

// `<id>/<version>/<arch>` path segments. `id` may contain dots (e.g.
// `notemd.md2pdf`); `arch` is a rust target triple. Kept deliberately strict so
// a crafted path can't wander outside the intended R2 key space (no `/`, no
// `..`).
const ID_RE = /^[a-zA-Z0-9._-]{1,80}$/
const VERSION_RE = /^[a-zA-Z0-9._+-]{1,40}$/
const ARCH_RE = /^[a-zA-Z0-9._-]{1,60}$/

function corsHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return headers
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = corsHeaders(init.headers as Record<string, string> | undefined)
  headers.set('content-type', 'application/json')
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  })
}

function notFound(): Response {
  return json({ error: 'not_found' }, { status: 404 })
}

/** GET / (and /index.html) — the marketplace landing page. */
function handleLanding(head: boolean): Response {
  const headers = corsHeaders({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
  })
  return new Response(head ? null : PAGE_HTML, { status: 200, headers })
}

function methodNotAllowed(allow: string): Response {
  return json({ error: 'method_not_allowed' }, { status: 405, headers: { allow } })
}

/** GET /api/index.json — the published index verbatim, CDN-cached 5 min. */
async function handleIndex(env: Env): Promise<Response> {
  const body = (await env.INDEX.get('index')) ?? EMPTY_INDEX
  return json(body, { headers: { 'cache-control': 'public, max-age=300' } })
}

/**
 * GET /api/download/<id>/<version>/<arch>[.minisig]
 * Streams the R2 object. The client's signature URL convention is exactly the
 * package URL + ".minisig", so a `.minisig` suffix maps to the sibling key
 * `<id>/<version>/<arch>.notemdpkg.minisig`.
 */
async function handleDownload(segments: string[], head: boolean, env: Env): Promise<Response> {
  // segments after `download`: [id, version, archOrArchSig]
  if (segments.length !== 3) return notFound()
  const [id, version, last] = segments

  const isSig = last.endsWith('.minisig')
  const arch = isSig ? last.slice(0, -'.minisig'.length) : last

  if (!ID_RE.test(id) || !VERSION_RE.test(version) || !ARCH_RE.test(arch)) {
    return notFound()
  }

  const key = isSig
    ? `${id}/${version}/${arch}.notemdpkg.minisig`
    : `${id}/${version}/${arch}.notemdpkg`

  if (head) {
    const meta = await env.PKGS.head(key)
    if (!meta) return notFound()
    return new Response(null, {
      status: 200,
      headers: corsHeaders({
        'content-type': 'application/octet-stream',
        'content-length': String(meta.size),
        'cache-control': 'public, max-age=31536000, immutable',
      }),
    })
  }

  const object = await env.PKGS.get(key)
  if (!object) return notFound()

  return new Response(object.body, {
    status: 200,
    headers: corsHeaders({
      'content-type': 'application/octet-stream',
      'content-length': String(object.size),
      'cache-control': 'public, max-age=31536000, immutable',
      etag: object.httpEtag,
    }),
  })
}

/** POST /api/stats/install {id,version} — best-effort counter bump. */
async function handleStats(req: Request, env: Env): Promise<Response> {
  // Fire-and-forget: any failure (bad body, KV hiccup) still returns 200 so the
  // client's telemetry POST never surfaces an error or blocks an install.
  try {
    const body = (await req.json()) as { id?: unknown }
    const id = typeof body?.id === 'string' ? body.id : ''
    if (id && ID_RE.test(id)) {
      const key = `stats:${id}`
      const prev = parseInt((await env.INDEX.get(key)) ?? '0', 10)
      const next = Number.isFinite(prev) ? prev + 1 : 1
      await env.INDEX.put(key, String(next))
    }
  } catch {
    // swallow — telemetry must never break the caller
  }
  return json({ ok: true })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const segments = url.pathname.split('/').filter(Boolean)

    // CORS preflight for any path.
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    // Landing page: `/` and `/index.html`.
    if (segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS')
      return handleLanding(req.method === 'HEAD')
    }

    if (segments[0] === 'api') {
      const rest = segments.slice(1)

      // /api/index.json
      if (rest.length === 1 && rest[0] === 'index.json') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS')
        const res = await handleIndex(env)
        return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res
      }

      // /api/download/<id>/<version>/<arch>[.minisig]
      if (rest[0] === 'download') {
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD, OPTIONS')
        return handleDownload(rest.slice(1), req.method === 'HEAD', env)
      }

      // /api/stats/install
      if (rest.length === 2 && rest[0] === 'stats' && rest[1] === 'install') {
        if (req.method !== 'POST') return methodNotAllowed('POST, OPTIONS')
        return handleStats(req, env)
      }
    }

    return notFound()
  },
}
