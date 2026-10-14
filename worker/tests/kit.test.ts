import { describe, expect, it } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import worker, { type Env } from '../src/index'
const bindings = env as unknown as Env
const AUTH = { Authorization: 'Bearer test-key' }
const bytes = new TextEncoder().encode('globalThis.NotemdShareEditor={apiVersion:1};')
async function target(body = bytes, extension = 'js') {
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(x => x.toString(16).padStart(2, '0')).join('')
  const name = `share-editor.${hex}.${extension}`
  return { url: `https://share.test/_kit/${name}`, key: `kit/${name}` }
}
describe('immutable editor kit transport', () => {
  it('requires owner Bearer, validates content identity, stores idempotently and serves public GET/HEAD', async () => {
    const { url, key } = await target()
    for (const headers of [{}, { 'X-Feedback-Token': 'visitor-token' }, { Authorization: 'Bearer wrong' }] as Record<string, string>[]) {
      const response = await SELF.fetch(url, { method: 'PUT', headers, body: bytes })
      expect(response.status).toBe(401)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    }
    expect(await bindings.MEDIA.head(key)).toBeNull()
    expect((await SELF.fetch(url, { method: 'PUT', headers: AUTH, body: bytes })).status).toBe(201)
    expect((await SELF.fetch(url, { method: 'PUT', headers: AUTH, body: bytes })).status).toBe(200)
    expect((await SELF.fetch(url, { method: 'PUT', headers: AUTH, body: 'different bytes for an existing name' })).status).toBe(400)
    const get = await SELF.fetch(url)
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes)
    const head = await SELF.fetch(url, { method: 'HEAD' })
    expect(await head.text()).toBe('')
    for (const response of [get, head]) {
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Length')).toBe(String(bytes.length))
      expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    }
    expect((await SELF.fetch(url, { method: 'DELETE', headers: AUTH })).status).toBe(405)
    expect(await bindings.MEDIA.head(key)).not.toBeNull()
  })
  it('rejects bad names and different bytes without storing', async () => {
    const { url, key } = await target()
    expect((await SELF.fetch(url, { method: 'PUT', headers: AUTH, body: 'different' })).status).toBe(400)
    expect(await bindings.MEDIA.head(key)).toBeNull()
    for (const path of ['bad.js', `nested/${url.split('/').pop()}`, 'share-editor.' + 'A'.repeat(64) + '.js', 'share-editor.' + 'a'.repeat(64) + '.html']) {
      expect((await SELF.fetch('https://share.test/_kit/' + path)).status).toBe(404)
    }
    expect((await SELF.fetch(url)).status).toBe(404)
  })
  it('enforces the 8MiB limit including unbounded streams and no Content-Length', async () => {
    const { url, key } = await target()
    const declared = await SELF.fetch(url, { method: 'PUT', headers: { ...AUTH, 'Content-Length': String(8 * 1024 * 1024 + 1) }, body: bytes })
    expect(declared.status).toBe(413)
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65536)) }, cancel() { cancelled = true } })
    const streamed = await worker.fetch(new Request(url, { method: 'PUT', headers: AUTH, body }), bindings)
    expect(streamed.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(await bindings.MEDIA.head(key)).toBeNull()
  })
  it('serves CSS and accepts exactly 8MiB, rejecting empty configured keys', async () => {
    const css = new Uint8Array(8 * 1024 * 1024).fill(32)
    const { url } = await target(css, 'css')
    expect((await SELF.fetch(url, { method: 'PUT', headers: AUTH, body: css })).status).toBe(201)
    expect((await SELF.fetch(url, { method: 'HEAD' })).headers.get('Content-Type')).toBe('text/css; charset=utf-8')
    const mermaid = (await target()).url.replace('share-editor.', 'share-editor-mermaid.')
    expect((await SELF.fetch(mermaid, { method: 'PUT', headers: AUTH, body: bytes })).status).toBe(201)
    expect(await (await SELF.fetch(mermaid)).text()).toBe(new TextDecoder().decode(bytes))
    expect((await worker.fetch(new Request(url, { method: 'PUT', headers: { Authorization: 'Bearer ' }, body: bytes }), { ...bindings, SHARE_API_KEY: '' })).status).toBe(401)
  })
})
