import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

const AUTH = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }
const VALID_TOKEN = 'a'.repeat(32)

interface RpcOk<T = unknown> { jsonrpc: '2.0'; id: number | string | null; result: T }
interface RpcErr { jsonrpc: '2.0'; id: number | string | null; error: { code: number; message: string; data?: unknown } }
type Rpc<T = unknown> = RpcOk<T> | RpcErr

async function rpc<T = unknown>(method: string, params?: unknown, id: number = 1, headers: HeadersInit = AUTH): Promise<Rpc<T>> {
  const r = await SELF.fetch('http://x/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  if (r.status !== 200 && r.status !== 401) throw new Error(`unexpected status ${r.status}`)
  if (r.status === 401) throw Object.assign(new Error('401'), { status: 401 })
  return r.json() as Promise<Rpc<T>>
}

describe('POST /mcp — protocol framework', () => {
  it('401 without Authorization', async () => {
    const r = await SELF.fetch('http://x/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    })
    expect(r.status).toBe(401)
  })

  it('rejects non-POST', async () => {
    const r = await SELF.fetch('http://x/mcp', { method: 'GET' })
    expect(r.status).toBe(405)
  })

  it('initialize returns serverInfo and tool capability', async () => {
    const body = await rpc<{ protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string; version: string } }>(
      'initialize',
      { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    )
    expect('result' in body).toBe(true)
    if (!('result' in body)) return
    expect(body.id).toBe(1)
    expect(body.result.serverInfo.name).toBe('mdeditor-share')
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.protocolVersion).toBe('2024-11-05')
  })

  it('unknown method returns JSON-RPC -32601', async () => {
    const body = await rpc('definitely_not_a_method', {})
    expect('error' in body).toBe(true)
    if (!('error' in body)) return
    expect(body.error.code).toBe(-32601)
  })

  it('parse error on invalid JSON returns -32700', async () => {
    const r = await SELF.fetch('http://x/mcp', {
      method: 'POST',
      headers: AUTH,
      body: '{not json',
    })
    expect(r.status).toBe(200)
    const body = await r.json() as RpcErr
    expect(body.error.code).toBe(-32700)
  })

  it('preserves request id (string)', async () => {
    const body = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } }, 'abc' as unknown as number)
    expect(body.id).toBe('abc')
  })
})

interface ToolContent { type: 'text'; text: string }
interface ToolResult { content: ToolContent[]; isError?: boolean }

async function callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<{ data?: T; result: ToolResult }> {
  const body = await rpc<ToolResult>('tools/call', { name, arguments: args })
  if ('error' in body) throw new Error(`rpc error ${body.error.code}: ${body.error.message}`)
  const result = body.result
  if (!result.isError && result.content[0]?.type === 'text') {
    return { data: JSON.parse(result.content[0].text) as T, result }
  }
  return { result }
}

const VALID_SLUG_A = '2026-05-08-mcp-test-aaa'
const VALID_SLUG_B = '2026-05-08-mcp-test-bbb'
const VALID_SLUG_C = '2026-05-08-mcp-test-ccc'

describe('tools/list', () => {
  it('returns the 6 expected tools with description and inputSchema', async () => {
    const body = await rpc<{ tools: Array<{ name: string; description: string; inputSchema: { type: string; properties: object; required?: string[] } }> }>('tools/list')
    expect('result' in body).toBe(true)
    if (!('result' in body)) return
    const names = body.result.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'share_delete',
      'share_delete_media',
      'share_get_html',
      'share_get_media_meta',
      'share_publish_html',
      'share_upload_media',
    ])
    for (const t of body.result.tools) {
      expect(t.description.length).toBeGreaterThan(20)
      expect(t.inputSchema.type).toBe('object')
      expect(t.inputSchema.properties).toBeDefined()
    }
  })
})

describe('tool: share_publish_html', () => {
  it('publishes and returns url + slug', async () => {
    const { data, result } = await callTool<{ slug: string; url: string; edit_token: string; expires_at: string | null }>('share_publish_html', {
      slug: VALID_SLUG_A,
      edit_token: VALID_TOKEN,
      html: '<!doctype html><p>mcp publish</p>',
    })
    expect(result.isError).toBeFalsy()
    expect(data!.slug).toBe(VALID_SLUG_A)
    expect(data!.url).toContain(`/${VALID_SLUG_A}`)
    expect(data!.expires_at).toBeNull()
  })

  it('isError on bad slug', async () => {
    const { result } = await callTool('share_publish_html', {
      slug: 'BAD',
      edit_token: VALID_TOKEN,
      html: '<p>x</p>',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('slug')
  })

  it('isError slug_conflict on token mismatch', async () => {
    await callTool('share_publish_html', { slug: VALID_SLUG_B, edit_token: VALID_TOKEN, html: '<p>v1</p>' })
    const { result } = await callTool('share_publish_html', {
      slug: VALID_SLUG_B, edit_token: 'b'.repeat(32), html: '<p>v2</p>',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('slug_conflict')
  })
})

describe('tool: share_get_html', () => {
  it('returns html + metadata for an existing slug', async () => {
    await callTool('share_publish_html', { slug: VALID_SLUG_C, edit_token: VALID_TOKEN, html: '<p>hi from get</p>' })
    const { data, result } = await callTool<{ slug: string; html: string; created_at: string }>('share_get_html', { slug: VALID_SLUG_C })
    expect(result.isError).toBeFalsy()
    expect(data!.html).toContain('hi from get')
    expect(data!.created_at).toBeTruthy()
  })

  it('isError when slug does not exist', async () => {
    const { result } = await callTool('share_get_html', { slug: '2026-01-01-not-here-zzz' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('not_found')
  })
})

describe('tool: share_delete', () => {
  it('deletes after publish (and second get returns isError)', async () => {
    const slug = '2026-05-08-mcp-del-aaa'
    await callTool('share_publish_html', { slug, edit_token: VALID_TOKEN, html: '<p>x</p>' })
    const { result } = await callTool('share_delete', { slug, edit_token: VALID_TOKEN })
    expect(result.isError).toBeFalsy()
    const { result: r2 } = await callTool('share_get_html', { slug })
    expect(r2.isError).toBe(true)
  })

  it('isError forbidden on token mismatch', async () => {
    const slug = '2026-05-08-mcp-del-bbb'
    await callTool('share_publish_html', { slug, edit_token: VALID_TOKEN, html: '<p>x</p>' })
    const { result } = await callTool('share_delete', { slug, edit_token: 'z'.repeat(32) })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('forbidden')
  })
})

const PNG_HEAD_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb])

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

describe('tool: share_upload_media', () => {
  it('uploads PNG and returns id + url', async () => {
    const { data, result } = await callTool<{ id: string; ext: string; url: string; size_bytes: number }>('share_upload_media', {
      content_type: 'image/png',
      body_base64: bytesToBase64(PNG_HEAD_B),
      edit_token: VALID_TOKEN,
    })
    expect(result.isError).toBeFalsy()
    expect(data!.ext).toBe('png')
    expect(data!.id).toMatch(/^[a-z0-9]{12}$/)
    expect(data!.url).toContain(`/f/${data!.id}.png`)
    expect(data!.size_bytes).toBe(PNG_HEAD_B.length)
  })

  it('isError on magic mismatch', async () => {
    const fake = new TextEncoder().encode('<html>not a png</html>')
    const { result } = await callTool('share_upload_media', {
      content_type: 'image/png',
      body_base64: bytesToBase64(fake),
      edit_token: VALID_TOKEN,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/magic|content/i)
  })

  it('isError on unsupported content_type', async () => {
    const { result } = await callTool('share_upload_media', {
      content_type: 'application/zip',
      body_base64: bytesToBase64(new Uint8Array([0x50, 0x4b])),
      edit_token: VALID_TOKEN,
    })
    expect(result.isError).toBe(true)
  })

  it('isError on malformed base64', async () => {
    const { result } = await callTool('share_upload_media', {
      content_type: 'image/png',
      body_base64: '!!!not-base64!!!',
      edit_token: VALID_TOKEN,
    })
    expect(result.isError).toBe(true)
  })
})

describe('tool: share_get_media_meta and share_delete_media', () => {
  it('round-trips: upload → meta → delete → meta isError', async () => {
    const up = await callTool<{ id: string; ext: string; size_bytes: number }>('share_upload_media', {
      content_type: 'image/png',
      body_base64: bytesToBase64(PNG_HEAD_B),
      edit_token: VALID_TOKEN,
    })
    const meta = await callTool<{ id: string; size_bytes: number; content_type: string }>('share_get_media_meta', {
      id: up.data!.id, ext: up.data!.ext,
    })
    expect(meta.result.isError).toBeFalsy()
    expect(meta.data!.size_bytes).toBe(up.data!.size_bytes)
    expect(meta.data!.content_type).toBe('image/png')

    const del = await callTool('share_delete_media', { id: up.data!.id, ext: up.data!.ext, edit_token: VALID_TOKEN })
    expect(del.result.isError).toBeFalsy()

    const after = await callTool('share_get_media_meta', { id: up.data!.id, ext: up.data!.ext })
    expect(after.result.isError).toBe(true)
  })

  it('share_delete_media isError on token mismatch', async () => {
    const up = await callTool<{ id: string; ext: string }>('share_upload_media', {
      content_type: 'image/png',
      body_base64: bytesToBase64(PNG_HEAD_B),
      edit_token: VALID_TOKEN,
    })
    const { result } = await callTool('share_delete_media', { id: up.data!.id, ext: up.data!.ext, edit_token: 'z'.repeat(32) })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('forbidden')
  })
})
