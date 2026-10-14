import type { Env } from './index'
import { boundedBody, digest } from './project-zip'

const NAME = /^share-editor(-mermaid)?\.([a-f0-9]{64})\.(js|css)$/
const MAX_BYTES = 8 * 1024 * 1024

export async function handleKit(req: Request, env: Env, url: URL): Promise<Response> {
  const name = url.pathname.slice('/_kit/'.length)
  const match = NAME.exec(name)
  if (!match) return new Response('Not Found', { status: 404 })
  const key = `kit/${name}`
  const contentType = match[3] === 'js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'
  if (req.method === 'PUT') {
    if (!env.SHARE_API_KEY || req.headers.get('Authorization') !== `Bearer ${env.SHARE_API_KEY}`) return new Response('Unauthorized', { status: 401 })
    let bytes: Uint8Array
    try { bytes = await boundedBody(req, MAX_BYTES) }
    catch { return new Response('Kit exceeds 8 MiB', { status: 413 }) }
    if (await digest(bytes) !== match[2]) return new Response('Kit hash mismatch', { status: 400 })
    if (await env.MEDIA.head(key)) return new Response(null, { status: 200 })
    await env.MEDIA.put(key, bytes, { httpMetadata: { contentType } })
    return new Response(null, { status: 201 })
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405 })
  let object: R2Object | null
  let body: ReadableStream | null = null
  if (req.method === 'GET') {
    const fetched = await env.MEDIA.get(key)
    object = fetched; body = fetched?.body ?? null
  } else object = await env.MEDIA.head(key)
  if (!object) return new Response(null, { status: 404 })
  return new Response(body, { headers: {
    'Content-Type': contentType, 'Content-Length': String(object.size),
    'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
  } })
}
