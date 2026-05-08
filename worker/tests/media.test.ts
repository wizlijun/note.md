import { describe, it, expect } from 'vitest'
import { SELF, env } from 'cloudflare:test'

interface TestEnv { MEDIA: R2Bucket }
const testEnv = env as unknown as TestEnv

const AUTH = { Authorization: 'Bearer test-key' }
const VALID_TOKEN = 'a'.repeat(32)

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
const GIF_HEAD = new TextEncoder().encode('GIF89a')
const WEBM_HEAD = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])

function pngBytes(payload = 'hello'): Uint8Array {
  const tail = new TextEncoder().encode(payload)
  const out = new Uint8Array(PNG_HEAD.length + tail.length)
  out.set(PNG_HEAD, 0)
  out.set(tail, PNG_HEAD.length)
  return out
}

function pad(head: Uint8Array, total = 64): Uint8Array {
  const out = new Uint8Array(total)
  out.set(head, 0)
  return out
}

function ftypBytes(brand: string, total = 32): Uint8Array {
  const out = new Uint8Array(total)
  out[3] = total
  out.set(new TextEncoder().encode('ftyp'), 4)
  out.set(new TextEncoder().encode(brand), 8)
  return out
}

function webpBytes(total = 32): Uint8Array {
  const out = new Uint8Array(total)
  out.set(new TextEncoder().encode('RIFF'), 0)
  out.set(new TextEncoder().encode('WEBP'), 8)
  return out
}

describe('POST /upload — auth & validation', () => {
  it('401 without Authorization', async () => {
    const r = await SELF.fetch('http://x/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'X-Edit-Token': VALID_TOKEN },
      body: pngBytes(),
    })
    expect(r.status).toBe(401)
  })

  it('400 when X-Edit-Token missing or malformed', async () => {
    const r = await SELF.fetch('http://x/upload', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'image/png', 'X-Edit-Token': 'short' },
      body: pngBytes(),
    })
    expect(r.status).toBe(400)
  })

  it('415 when Content-Type not in whitelist', async () => {
    const r = await SELF.fetch('http://x/upload', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'application/zip', 'X-Edit-Token': VALID_TOKEN },
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    })
    expect(r.status).toBe(415)
  })

  it('413 when body exceeds 50 MB', async () => {
    const tooBig = new Uint8Array(50 * 1024 * 1024 + 1)
    tooBig.set(PNG_HEAD, 0)
    const r = await SELF.fetch('http://x/upload', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'image/png', 'X-Edit-Token': VALID_TOKEN },
      body: tooBig,
    })
    expect(r.status).toBe(413)
  })

  it('400 when X-Expires-In is below minimum', async () => {
    const r = await SELF.fetch('http://x/upload', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'image/png',
        'X-Edit-Token': VALID_TOKEN,
        'X-Expires-In': '30',
      },
      body: pngBytes(),
    })
    expect(r.status).toBe(400)
  })
})

describe('POST /upload — magic bytes', () => {
  async function upload(ct: string, body: Uint8Array): Promise<number> {
    const r = await SELF.fetch('http://x/upload', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': ct, 'X-Edit-Token': VALID_TOKEN },
      body,
    })
    return r.status
  }

  it('415 when body bytes do not match declared image/png', async () => {
    const html = new TextEncoder().encode('<html><body>not png</body></html>')
    expect(await upload('image/png', html)).toBe(415)
  })

  it('accepts a real PNG header', async () => {
    expect(await upload('image/png', pngBytes())).not.toBe(415)
  })

  it('accepts a real JPEG header', async () => {
    expect(await upload('image/jpeg', pad(JPEG_HEAD))).not.toBe(415)
  })

  it('accepts a real GIF header', async () => {
    expect(await upload('image/gif', pad(GIF_HEAD))).not.toBe(415)
  })

  it('accepts a real WebP header', async () => {
    expect(await upload('image/webp', webpBytes())).not.toBe(415)
  })

  it('accepts MP4 ftypisom', async () => {
    expect(await upload('video/mp4', ftypBytes('isom'))).not.toBe(415)
  })

  it('accepts WebM EBML header', async () => {
    expect(await upload('video/webm', pad(WEBM_HEAD))).not.toBe(415)
  })

  it('accepts MOV ftypqt  ', async () => {
    expect(await upload('video/quicktime', ftypBytes('qt  '))).not.toBe(415)
  })

  it('accepts AVIF ftypavif', async () => {
    expect(await upload('image/avif', ftypBytes('avif'))).not.toBe(415)
  })

  it('accepts HEIC ftypheic', async () => {
    expect(await upload('image/heic', ftypBytes('heic'))).not.toBe(415)
  })

  it('accepts SVG by content (XML)', async () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')
    expect(await upload('image/svg+xml', svg)).not.toBe(415)
  })

  it('rejects SVG with no <svg> tag', async () => {
    const fake = new TextEncoder().encode('<html>nope</html>')
    expect(await upload('image/svg+xml', fake)).toBe(415)
  })
})

describe('POST /upload — success', () => {
  it('200 returns id, ext, url, expires_at=null', async () => {
    const r = await SELF.fetch('http://x/upload', {
      method: 'POST',
      headers: { ...AUTH, 'Content-Type': 'image/png', 'X-Edit-Token': VALID_TOKEN },
      body: pngBytes('one'),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as {
      id: string; ext: string; url: string; edit_token: string;
      expires_at: string | null; size_bytes: number;
    }
    expect(body.ext).toBe('png')
    expect(body.id).toMatch(/^[a-z0-9]{12}$/)
    expect(body.url).toBe(`http://x/f/${body.id}.png`)
    expect(body.edit_token).toBe(VALID_TOKEN)
    expect(body.expires_at).toBeNull()
    expect(body.size_bytes).toBe(pngBytes('one').byteLength)
  })

  it('expires_at set when X-Expires-In is provided', async () => {
    const r = await SELF.fetch('http://x/upload', {
      method: 'POST',
      headers: {
        ...AUTH,
        'Content-Type': 'image/png',
        'X-Edit-Token': VALID_TOKEN,
        'X-Expires-In': '3600',
      },
      body: pngBytes('two'),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { expires_at: string | null }
    expect(body.expires_at).not.toBeNull()
    const at = new Date(body.expires_at as string).getTime()
    const now = Date.now()
    expect(at).toBeGreaterThan(now + 3000_000)
    expect(at).toBeLessThan(now + 4000_000)
  })

  it('two uploads of identical content produce different ids', async () => {
    const headers = { ...AUTH, 'Content-Type': 'image/png', 'X-Edit-Token': VALID_TOKEN }
    const a = await (await SELF.fetch('http://x/upload', { method: 'POST', headers, body: pngBytes('same') })).json() as { id: string }
    const b = await (await SELF.fetch('http://x/upload', { method: 'POST', headers, body: pngBytes('same') })).json() as { id: string }
    expect(a.id).not.toBe(b.id)
  })
})

async function uploadOnce(ct: string, body: Uint8Array): Promise<{ id: string; ext: string; url: string }> {
  const r = await SELF.fetch('http://x/upload', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': ct, 'X-Edit-Token': VALID_TOKEN },
    body,
  })
  return r.json() as Promise<{ id: string; ext: string; url: string }>
}

describe('GET /f/:id.:ext', () => {
  it('410 for missing id', async () => {
    const r = await SELF.fetch('http://x/f/nonexistent1.png')
    expect(r.status).toBe(410)
  })

  it('200 returns full file bytes with correct Content-Type', async () => {
    const original = pngBytes('roundtrip')
    const { url } = await uploadOnce('image/png', original)
    const r = await SELF.fetch(url)
    expect(r.status).toBe(200)
    expect(r.headers.get('Content-Type')).toBe('image/png')
    const got = new Uint8Array(await r.arrayBuffer())
    expect(got.byteLength).toBe(original.byteLength)
    expect(got[0]).toBe(0x89)
  })

  it('sets immutable cache and noindex headers', async () => {
    const { url } = await uploadOnce('image/png', pngBytes('cache'))
    const r = await SELF.fetch(url)
    expect(r.headers.get('Cache-Control')).toContain('immutable')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
  })

  it('206 for Range requests with correct slice', async () => {
    const original = pngBytes('rangerangerange')
    const { url } = await uploadOnce('image/png', original)
    const r = await SELF.fetch(url, { headers: { Range: 'bytes=0-7' } })
    expect(r.status).toBe(206)
    expect(r.headers.get('Content-Range')).toBe(`bytes 0-7/${original.byteLength}`)
    const got = new Uint8Array(await r.arrayBuffer())
    expect(got.byteLength).toBe(8)
    expect(Array.from(got)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('410 after expires_at has passed', async () => {
    const { id, ext } = await uploadOnce('image/png', pngBytes('exp'))
    const key = `f/${id}.${ext}`
    const obj = await testEnv.MEDIA.get(key)
    const data = await obj!.arrayBuffer()
    await testEnv.MEDIA.put(key, data, {
      httpMetadata: { contentType: 'image/png' },
      customMetadata: {
        ...obj!.customMetadata,
        expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    })
    const r = await SELF.fetch(`http://x/${key}`)
    expect(r.status).toBe(410)
    expect(await testEnv.MEDIA.head(key)).toBeNull()
  })
})

describe('GET /f/:id.svg — SVG safety', () => {
  it('serves SVG with sandboxing headers', async () => {
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')
    const { url } = await uploadOnce('image/svg+xml', svg)
    const r = await SELF.fetch(url)
    expect(r.status).toBe(200)
    expect(r.headers.get('Content-Type')).toBe('image/svg+xml')
    expect(r.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(r.headers.get('Content-Disposition')).toContain('inline')
  })
})

describe('DELETE /f/:id.:ext', () => {
  it('401 without Authorization', async () => {
    const { id, ext } = await uploadOnce('image/png', pngBytes('del1'))
    const r = await SELF.fetch(`http://x/f/${id}.${ext}`, {
      method: 'DELETE',
      body: JSON.stringify({ edit_token: VALID_TOKEN }),
    })
    expect(r.status).toBe(401)
  })

  it('404 for non-existent', async () => {
    const r = await SELF.fetch('http://x/f/nonexistxxxx.png', {
      method: 'DELETE',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ edit_token: VALID_TOKEN }),
    })
    expect(r.status).toBe(404)
  })

  it('403 when edit_token does not match', async () => {
    const { id, ext } = await uploadOnce('image/png', pngBytes('del2'))
    const r = await SELF.fetch(`http://x/f/${id}.${ext}`, {
      method: 'DELETE',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ edit_token: 'z'.repeat(32) }),
    })
    expect(r.status).toBe(403)
  })

  it('204 with matching token, then GET 410', async () => {
    const { id, ext, url } = await uploadOnce('image/png', pngBytes('del3'))
    const r = await SELF.fetch(`http://x/f/${id}.${ext}`, {
      method: 'DELETE',
      headers: { ...AUTH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ edit_token: VALID_TOKEN }),
    })
    expect(r.status).toBe(204)
    const get = await SELF.fetch(url)
    expect(get.status).toBe(410)
  })
})
