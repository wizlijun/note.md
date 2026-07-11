import { describe, it, expect } from 'vitest'
import { SELF } from 'cloudflare:test'

const HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer test-key',
}

const VALID_SLUG = '2026-05-08-foo-x7k'
const VALID_TOKEN = 'a'.repeat(32)

describe('POST /publish', () => {
  it('rejects 401 without Authorization', async () => {
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>x</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    expect(r.status).toBe(401)
  })

  it('rejects 400 on bad slug format', async () => {
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ slug: 'BADSLUG', edit_token: VALID_TOKEN, html: '<p>x</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    expect(r.status).toBe(400)
  })

  it('publishes a new share and returns 200 with URL', async () => {
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>hello</p>', metadata: { original_filename: 'foo.md', source_ext: 'md' } }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { slug: string; url: string }
    expect(body.slug).toBe(VALID_SLUG)
  })

  it('returns 409 when republishing same slug with wrong token', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>v1</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: 'b'.repeat(32), html: '<p>v2</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    expect(r.status).toBe(409)
  })

  it('overwrites with matching token', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>v1</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>v2</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    expect(r.status).toBe(200)
    const get = await SELF.fetch(`http://x/${VALID_SLUG}`)
    expect(await get.text()).toContain('v2')
  })
})

describe('GET /:slug', () => {
  it('returns 410 for missing slug', async () => {
    const r = await SELF.fetch('http://x/2026-01-01-doesnotexist-abc')
    expect(r.status).toBe(410)
    expect(r.headers.get('Content-Type')).toContain('text/html')
  })

  it('returns the stored HTML with proper headers', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<!doctype html><p>page</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch(`http://x/${VALID_SLUG}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('Content-Type')).toContain('text/html')
    expect(r.headers.get('X-Robots-Tag')).toBe('noindex')
    expect(await r.text()).toContain('<p>page</p>')
  })

  it('HEAD returns 200 with headers and no body (link checkers / unfurlers)', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<!doctype html><p>page</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch(`http://x/${VALID_SLUG}`, { method: 'HEAD' })
    expect(r.status).toBe(200)
    expect(r.headers.get('Content-Type')).toContain('text/html')
    expect(await r.text()).toBe('')
  })

  it('HEAD returns 410 for a missing slug (not a bare 404)', async () => {
    const r = await SELF.fetch('http://x/2026-01-01-doesnotexist-abc', { method: 'HEAD' })
    expect(r.status).toBe(410)
  })

  it('OPTIONS on a share path returns 204 with Allow (not 404)', async () => {
    const r = await SELF.fetch(`http://x/${VALID_SLUG}`, { method: 'OPTIONS' })
    expect(r.status).toBe(204)
    expect(r.headers.get('Allow')).toContain('GET')
  })
})

describe('DELETE /:slug', () => {
  it('rejects 401 without Authorization', async () => {
    const r = await SELF.fetch('http://x/2026-05-08-x-aaa', {
      method: 'DELETE',
      body: JSON.stringify({ edit_token: VALID_TOKEN }),
    })
    expect(r.status).toBe(401)
  })

  it('returns 404 for missing slug', async () => {
    const r = await SELF.fetch('http://x/2026-05-08-x-aaa', {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ edit_token: VALID_TOKEN }),
    })
    expect(r.status).toBe(404)
  })

  it('returns 403 for token mismatch', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>x</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch(`http://x/${VALID_SLUG}`, {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ edit_token: 'z'.repeat(32) }),
    })
    expect(r.status).toBe(403)
  })

  it('deletes with matching token (204)', async () => {
    await SELF.fetch('http://x/publish', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ slug: VALID_SLUG, edit_token: VALID_TOKEN, html: '<p>x</p>', metadata: { original_filename: 'a', source_ext: 'md' } }),
    })
    const r = await SELF.fetch(`http://x/${VALID_SLUG}`, {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({ edit_token: VALID_TOKEN }),
    })
    expect(r.status).toBe(204)
    const get = await SELF.fetch(`http://x/${VALID_SLUG}`)
    expect(get.status).toBe(410)
  })
})
