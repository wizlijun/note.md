import { describe, expect, it } from 'vitest'
import { SELF, env } from 'cloudflare:test'
import { strToU8, zipSync, Zip, ZipDeflate } from 'fflate'
import worker, { type Env } from '../src/index'
import { projectStateKey } from '../src/project'

const bindings = env as unknown as Env
const slug = '2026-10-10-staged-project'
const token = 'a'.repeat(32)
const auth = { Authorization: 'Bearer test-key' }
const root = `http://x/project/${slug}`
async function hash(bytes: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('')
}
async function entry(publicationId = 'pub_1', previousPublicationId: string | null = null, extra = {}) {
  return SELF.fetch(root + '/entry', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({
    publicationId, previousPublicationId, snapshotId: 'entry_' + publicationId, project_id: 'project_1', edit_token: token,
    feedback_token_hash: await hash(strToU8('visitor')), html: '<p>entry ' + publicationId + '</p>', entry: 'README.md', title: 'My project', expires_in_seconds: 3600, ...extra,
  }) })
}
async function archive(snapshotId = 'full_1', extraFiles: Record<string, Uint8Array> = {}, manifestExtra = {}) {
  const source = strToU8('# Hello')
  const prefix = `.__notemd-${snapshotId}/`
  return zipSync({ 'README.md': source, ...extraFiles,
    [prefix + 'reader.html']: strToU8('<p>full ' + snapshotId + '</p>'),
    [prefix + 'manifest.json']: strToU8(JSON.stringify({ schemaVersion: 1, project_id: 'project_1', snapshotId, entry: 'README.md', htmlPath: prefix + 'reader.html', files: [{ path: 'README.md', hash: await hash(source), bytes: source.length }], ...manifestExtra })),
  })
}
function upload(bytes: Uint8Array, publicationId = 'pub_1', snapshotId = 'full_1') {
  return SELF.fetch(root + '/archive', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/zip', 'X-Edit-Token': token, 'X-Publication-Id': publicationId, 'X-Snapshot-Id': snapshotId }, body: bytes })
}
async function stop(extra = {}) {
  return SELF.fetch('http://x/' + slug, { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ edit_token: token, ...extra }) })
}

describe('two stage project publication', () => {
  it('serves entry immediately, then atomically serves full and retains exact ZIP', async () => {
    const first = await entry()
    expect(first.status).toBe(200)
    const receipt = await first.json() as any
    expect(receipt.stage).toBe('entry')
    expect((await SELF.fetch(root + '/download')).status).toBe(409)
    const page = await SELF.fetch('http://x/' + slug)
    expect(page.headers.get('Cache-Control')).toBe('no-store')
    expect(await page.text()).toContain('entry pub_1')
    const zip = await archive()
    const completed = await upload(zip)
    expect(completed.status).toBe(200)
    expect((await completed.json() as any).expires_at).toBe(receipt.expires_at)
    expect(await (await SELF.fetch('http://x/' + slug)).text()).toContain('full full_1')
    const download = await SELF.fetch(root + '/download')
    expect(download.headers.get('Content-Disposition')).toContain('attachment')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(zip)
    expect((await upload(zip)).status).toBe(200)
    expect((await entry()).status).toBe(200)
    expect(await (await SELF.fetch('http://x/' + slug)).text()).toContain('full full_1')
  })
  it('keeps the old complete page until the next complete package is ready', async () => {
    await entry(); await upload(await archive())
    const next = await entry('pub_2', 'pub_1')
    expect(next.status).toBe(200)
    expect((await next.json() as any).active.snapshotId).toBe('full_1')
    expect(await (await SELF.fetch('http://x/' + slug)).text()).toContain('full full_1')
    expect((await upload(await archive('full_2'), 'pub_2', 'full_2')).status).toBe(200)
    expect(await (await SELF.fetch('http://x/' + slug)).text()).toContain('full full_2')
    expect((await entry('pub_1')).status).toBe(409)
  })
  it('does not resurrect a revoked share through late entry or full, including stale KV', async () => {
    await entry()
    await bindings.SHARES.put(slug, '<p>stale legacy</p>', { metadata: { edit_token: token } })
    expect((await stop()).status).toBe(200)
    expect((await entry()).status).toBe(410)
    expect((await upload(await archive())).status).toBe(410)
    expect((await SELF.fetch('http://x/' + slug)).status).toBe(410)
    expect((await SELF.fetch(root + '/download')).status).toBe(410)
    expect((await entry('pub_2', 'pub_1')).status).toBe(200)
  })
  it('rejects unknown ZIP entries, altered hashes and unsafe paths without replacing entry', async () => {
    await entry()
    for (const bytes of [await archive('full_1', { 'unknown.txt': strToU8('secret') }), await archive('full_1', { '../escape': strToU8('secret') }), await archive('full_1', {}, { files: [{ path: 'README.md', hash: '0'.repeat(64), bytes: 7 }] })]) {
      expect((await upload(bytes)).status).toBe(400)
    }
    expect(await (await SELF.fetch('http://x/' + slug)).text()).toContain('entry pub_1')
  })
  it('rejects unauthenticated owners and mismatched predecessor', async () => {
    expect((await SELF.fetch(root + '/entry', { method: 'POST', body: '{}' })).status).toBe(401)
    await entry()
    expect((await entry('pub_2', null)).status).toBe(409)
    expect((await entry('pub_2', 'pub_1', { edit_token: 'b'.repeat(32) })).status).toBe(403)
  })
  it('reserves a tombstone before an unknown first entry has arrived', async () => {
    const stopped = await stop({ project_id: 'project_1', publicationId: 'pub_1', previousPublicationId: null })
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({ publicationId: 'pub_1' })
    expect((await entry()).status).toBe(410)
    expect((await entry('pub_2', 'pub_1')).status).toBe(200)
  })
  it('advances the tombstone to an unknown pending update and preserves a later generation', async () => {
    await entry(); await upload(await archive())
    const stopped = await stop({ project_id: 'project_1', publicationId: 'pub_2', previousPublicationId: 'pub_1' })
    expect(await stopped.json()).toEqual({ publicationId: 'pub_2' })
    expect((await entry('pub_2', 'pub_1')).status).toBe(410)
    await entry('pub_3', 'pub_2')
    expect(await (await stop({ project_id: 'project_1', publicationId: 'pub_2', previousPublicationId: 'pub_1' })).json()).toEqual({ publicationId: 'pub_3' })
  })
  it('makes full CAS fail when a concurrent revocation wins immediately before commit', async () => {
    await entry()
    let intercepted = false
    const bucket = bindings.MEDIA
    const media = {
      get: bucket.get.bind(bucket), head: bucket.head.bind(bucket),
      async put(key: string, value: any, options: any) {
        if (key === projectStateKey(slug) && options?.onlyIf?.etagMatches && JSON.parse(value).active.archiveKey) {
          intercepted = true
          expect((await stop()).status).toBe(200)
        }
        return bucket.put(key, value, options)
      },
    } as unknown as R2Bucket
    const bytes = await archive()
    const response = await worker.fetch(new Request(root + '/archive', { method: 'POST', headers: { ...auth, 'X-Edit-Token': token, 'X-Publication-Id': 'pub_1', 'X-Snapshot-Id': 'full_1' }, body: bytes }), { ...bindings, MEDIA: media })
    expect(intercepted).toBe(true)
    expect(response.status).toBe(409)
    expect((await SELF.fetch('http://x/' + slug)).status).toBe(410)
    expect((await SELF.fetch(root + '/download')).status).toBe(410)
  })
  it('upgrades a legacy project without replacing its old complete page during upload', async () => {
    const old = '<p>old full</p><script id="project-data" type="application/json">' + JSON.stringify({ snapshot: { project_id: 'project_1', snapshotId: 'old_snapshot' } }) + '</script>'
    await bindings.SHARES.put(slug, old, { metadata: { edit_token: token, project_id: 'project_1', feedback_token_hash: await hash(strToU8('visitor')), expires_at: null } })
    const response = await entry()
    const receipt = await response.json() as any
    expect(receipt.stage).toBe('ready')
    expect(receipt.active.snapshotId).toBe('old_snapshot')
    expect(await (await SELF.fetch('http://x/' + slug)).text()).toBe(old)
    expect((await upload(await archive())).status).toBe(200)
  })
  it('enforces active expiry for page, HEAD/download and feedback while preserving historical S1 feedback', async () => {
    await entry(); await upload(await archive())
    const feedback = () => SELF.fetch('http://x/feedback/' + slug, { method: 'POST', headers: { 'X-Feedback-Token': 'visitor' }, body: JSON.stringify({ schemaVersion: 1, project_id: 'project_1', snapshotId: 'entry_pub_1', submissionId: 'sub_1', edits: [], annotations: [] }) })
    expect((await feedback()).status).toBe(200)
    const head = await SELF.fetch(root + '/download', { method: 'HEAD' })
    expect(head.status).toBe(200); expect(await head.text()).toBe('')
    const object = await bindings.MEDIA.get(projectStateKey(slug)), state = await object!.json() as any
    state.active.expires_at = '2000-01-01T00:00:00.000Z'
    await bindings.MEDIA.put(projectStateKey(slug), JSON.stringify(state))
    for (const url of ['http://x/' + slug, root + '/download']) expect((await SELF.fetch(url)).status).toBe(410)
    expect((await SELF.fetch(root + '/download', { method: 'HEAD' })).status).toBe(410)
    expect((await feedback()).status).toBe(410)
    expect((await upload(await archive())).status).toBe(410)
  })
  it('accepts streaming descriptor ZIPs produced by the host and rejects a forged expansion length', async () => {
    await entry()
    const source = strToU8('# Hello'), prefix = '.__notemd-full_1/'
    const content: Record<string, Uint8Array> = { 'README.md': source,
      [prefix + 'manifest.json']: strToU8(JSON.stringify({ schemaVersion: 1, project_id: 'project_1', snapshotId: 'full_1', entry: 'README.md', htmlPath: prefix + 'reader.html', files: [{ path: 'README.md', hash: await hash(source), bytes: source.length }] })),
      [prefix + 'reader.html']: strToU8('<p>full</p>') }
    const chunks: Uint8Array[] = []
    const stream = new Zip((error, data) => { if (error) throw error; chunks.push(data) })
    for (const [path, bytes] of Object.entries(content)) { const file = new ZipDeflate(path, { level: 6 }); file.mtime = new Date(1980, 0, 1); stream.add(file); file.push(bytes, true) }
    stream.end()
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let p = 0
    for (const chunk of chunks) { bytes.set(chunk, p); p += chunk.length }
    expect((await upload(bytes)).status).toBe(200)
  })
  it('rejects actual inflated output beyond forged sizes before publishing', async () => {
    await entry()
    const bytes = await archive('full_1', {}, { files: [{ path: 'README.md', hash: '0'.repeat(64), bytes: 1 }] })
    const view = new DataView(bytes.buffer)
    // Forge both local/central sizes consistently; inflate still emits seven bytes.
    view.setUint32(22, 1, true)
    for (let i = 0; i < bytes.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 1, true); break }
    expect((await upload(bytes)).status).toBe(400)
    expect(await (await SELF.fetch('http://x/' + slug)).text()).toContain('entry pub_1')
  })
  it('keeps a permanent pending update permanent even when the old active page expires', async () => {
    await entry(); await upload(await archive())
    const update = await entry('pub_2', 'pub_1', { expires_in_seconds: null })
    expect((await update.json() as any).expires_at).toBeNull()
    const object = await bindings.MEDIA.get(projectStateKey(slug)), state = await object!.json() as any
    state.active.expires_at = '2000-01-01T00:00:00.000Z'
    await bindings.MEDIA.put(projectStateKey(slug), JSON.stringify(state))
    expect((await SELF.fetch('http://x/' + slug)).status).toBe(410)
    const completed = await upload(await archive('full_2'), 'pub_2', 'full_2')
    expect(completed.status).toBe(200)
    expect((await completed.json() as any).expires_at).toBeNull()
    const page = await SELF.fetch('http://x/' + slug)
    expect(page.status).toBe(200); await page.text()
  })
  it('rejects a high-ratio expansion despite forged small local and central sizes', async () => {
    await entry()
    const prefix = '.__notemd-full_1/', expanded = new Uint8Array(1024 * 1024).fill(65)
    const bytes = zipSync({ 'README.md': expanded,
      [prefix + 'reader.html']: strToU8('<p>full</p>'),
      [prefix + 'manifest.json']: strToU8(JSON.stringify({ schemaVersion: 1, project_id: 'project_1', snapshotId: 'full_1', entry: 'README.md', htmlPath: prefix + 'reader.html', files: [{ path: 'README.md', hash: '0'.repeat(64), bytes: 1 }] })),
    }, { level: 9 })
    const view = new DataView(bytes.buffer)
    view.setUint32(22, 1, true)
    for (let i = 0; i < bytes.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 1, true); break }
    expect((await upload(bytes)).status).toBe(400)
    expect((await SELF.fetch(root + '/download', { method: 'HEAD' })).status).toBe(409)
  })
  it('processes the maximum source and HTML output sequentially without buffering all expanded files', async () => {
    await entry()
    async function largePackage() {
      const source = new Uint8Array(25 * 1024 * 1024).fill(65), html = new Uint8Array(25 * 1024 * 1024).fill(66)
      const prefix = '.__notemd-full_1/'
      return zipSync({ 'README.md': source, [prefix + 'reader.html']: html,
        [prefix + 'manifest.json']: strToU8(JSON.stringify({ schemaVersion: 1, project_id: 'project_1', snapshotId: 'full_1', entry: 'README.md', htmlPath: prefix + 'reader.html', files: [{ path: 'README.md', hash: await hash(source), bytes: source.length }] })),
      }, { level: 1 })
    }
    expect((await upload(await largePackage())).status).toBe(200)
    const head = await SELF.fetch(root + '/download', { method: 'HEAD' })
    expect(head.status).toBe(200); expect(await head.text()).toBe('')
  }, 15000)
  it('cleans only obsolete owned objects after replacement and revocation, retaining entry retry metadata', async () => {
    await bindings.MEDIA.put('feedback/project_1/keep.json', '{}')
    await bindings.MEDIA.put('f/keep.png', 'keep')
    await entry(); await upload(await archive())
    const keys = async () => (await bindings.MEDIA.list({ prefix: `project-share/${slug}/` })).objects.map(o => o.key)
    expect(await keys()).toHaveLength(3)
    expect((await entry()).status).toBe(200)
    await entry('pub_2', 'pub_1')
    expect(await keys()).toHaveLength(4)
    await upload(await archive('full_2'), 'pub_2', 'full_2')
    expect(await keys()).toHaveLength(3)
    expect((await keys()).every(key => key.endsWith('state.json') || key.includes('/pub_2/full_2/'))).toBe(true)
    await stop()
    expect(await keys()).toEqual([projectStateKey(slug)])
    expect(await bindings.MEDIA.head('feedback/project_1/keep.json')).not.toBeNull()
    expect(await bindings.MEDIA.head('f/keep.png')).not.toBeNull()
  })
  it('does not hide a successful full commit when cleanup fails and retries the persisted known keys', async () => {
    await entry()
    const bucket = bindings.MEDIA
    const media = { get: bucket.get.bind(bucket), head: bucket.head.bind(bucket), put: bucket.put.bind(bucket),
      delete: async () => { throw new Error('injected cleanup failure') },
    } as unknown as R2Bucket
    const zip = await archive()
    const response = await worker.fetch(new Request(root + '/archive', { method: 'POST', headers: { ...auth, 'X-Edit-Token': token, 'X-Publication-Id': 'pub_1', 'X-Snapshot-Id': 'full_1' }, body: zip }), { ...bindings, MEDIA: media })
    expect(response.status).toBe(200)
    const staleKey = `project-share/${slug}/pub_1/entry_pub_1/entry.html`
    expect(await bucket.head(staleKey)).not.toBeNull()
    expect((await (await bucket.get(projectStateKey(slug)))!.json() as any).cleanup).toContain(staleKey)
    expect((await upload(zip)).status).toBe(200)
    expect(await bucket.head(staleKey)).toBeNull()
    expect((await SELF.fetch(root + '/download', { method: 'HEAD' })).status).toBe(200)
  })
  it('does not delete the winner objects when a concurrent identical full commit wins', async () => {
    await entry()
    const bucket = bindings.MEDIA, zip = await archive()
    let intercepted = false
    const media = { get: bucket.get.bind(bucket), head: bucket.head.bind(bucket), delete: bucket.delete.bind(bucket),
      async put(key: string, value: any, options: any) {
        if (!intercepted && key === projectStateKey(slug) && options?.onlyIf?.etagMatches && JSON.parse(value).active.archiveKey) {
          intercepted = true
          expect((await upload(zip)).status).toBe(200)
        }
        return bucket.put(key, value, options)
      },
    } as unknown as R2Bucket
    const response = await worker.fetch(new Request(root + '/archive', { method: 'POST', headers: { ...auth, 'X-Edit-Token': token, 'X-Publication-Id': 'pub_1', 'X-Snapshot-Id': 'full_1' }, body: zip }), { ...bindings, MEDIA: media })
    expect(response.status).toBe(409)
    const download = await SELF.fetch(root + '/download')
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(zip)
  })
  it('rejects symlink metadata, case collisions and truncated descriptors before switching', async () => {
    await entry()
    const link = await archive(), descriptor = await archive()
    const linkView = new DataView(link.buffer), descriptorView = new DataView(descriptor.buffer)
    for (let i = 0; i < link.length - 46; i++) if (linkView.getUint32(i, true) === 0x02014b50) { linkView.setUint32(i + 38, 0xa1ff0000, true); break }
    descriptorView.setUint16(6, descriptorView.getUint16(6, true) | 8, true)
    for (let i = 0; i < descriptor.length - 46; i++) if (descriptorView.getUint32(i, true) === 0x02014b50) { descriptorView.setUint16(i + 8, descriptorView.getUint16(i + 8, true) | 8, true); break }
    for (const bytes of [link, descriptor, await archive('full_1', { 'readme.md': strToU8('other') })]) expect((await upload(bytes)).status).toBe(400)
    expect((await SELF.fetch(root + '/download', { method: 'HEAD' })).status).toBe(409)
  })
  it('enforces the ZIP input limit and refuses legacy publish from bypassing a tombstone', async () => {
    await entry(); await stop()
    const bypass = await SELF.fetch('http://x/publish', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, edit_token: token, html: '<p>bypass</p>' }) })
    expect(bypass.status).toBe(409)
    await entry('pub_2', 'pub_1')
    const tooLarge = await SELF.fetch(root + '/archive', { method: 'POST', headers: { ...auth, 'X-Edit-Token': token, 'X-Publication-Id': 'pub_2', 'X-Snapshot-Id': 'full_2', 'Content-Length': String(32 * 1024 * 1024 + 1) }, body: 'small body' })
    expect(tooLarge.status).toBe(413)
    const head = await SELF.fetch('http://x/' + slug, { method: 'HEAD' })
    expect(head.status).toBe(200); expect(await head.text()).toBe('')
  })
  it('accepts JSON-escaped HTML larger than the old transport cap while enforcing decoded HTML size', async () => {
    const response = await entry('pub_1', null, { html: '"'.repeat(14 * 1024 * 1024) })
    expect(response.status).toBe(200)
    const head = await SELF.fetch('http://x/' + slug, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('Content-Length')).toBe(String(14 * 1024 * 1024))
  }, 15000)
  it('persists both attempted package keys before unknown full HTML put results and cleans them on stop', async () => {
    await entry()
    const bucket = bindings.MEDIA
    const media = { get: bucket.get.bind(bucket), head: bucket.head.bind(bucket), delete: bucket.delete.bind(bucket),
      async put(key: string, value: any, options: any) {
        const result = await bucket.put(key, value, options)
        if (key.endsWith('/full.html')) throw new Error('injected unknown HTML put result')
        return result
      },
    } as unknown as R2Bucket
    const request = new Request(root + '/archive', { method: 'POST', headers: { ...auth, 'X-Edit-Token': token, 'X-Publication-Id': 'pub_1', 'X-Snapshot-Id': 'full_1' }, body: await archive() })
    await expect(worker.fetch(request, { ...bindings, MEDIA: media })).rejects.toThrow('unknown HTML put')
    const state = await (await bucket.get(projectStateKey(slug)))!.json() as any
    expect(state.attempt.snapshotId).toBe('full_1')
    expect(await bucket.head(state.attempt.archiveKey)).not.toBeNull()
    expect(await bucket.head(state.attempt.htmlKey)).not.toBeNull()
    await stop()
    expect((await bucket.list({ prefix: `project-share/${slug}/` })).objects.map(o => o.key)).toEqual([projectStateKey(slug)])
  })
  it('cleans an unknown initial entry put using exact host snapshot IDs without scanning prefixes', async () => {
    const bucket = bindings.MEDIA
    const media = { get: bucket.get.bind(bucket), head: bucket.head.bind(bucket), delete: bucket.delete.bind(bucket),
      async put(key: string, value: any, options: any) {
        const result = await bucket.put(key, value, options)
        if (key.endsWith('/entry.html')) throw new Error('injected unknown entry put result')
        return result
      },
    } as unknown as R2Bucket
    const request = new Request(root + '/entry', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({
      publicationId: 'pub_1', previousPublicationId: null, snapshotId: 'entry_pub_1', project_id: 'project_1', edit_token: token,
      feedback_token_hash: await hash(strToU8('visitor')), html: '<p>entry</p>', entry: 'README.md', title: 'Project', expires_in_seconds: 3600,
    }) })
    await expect(worker.fetch(request, { ...bindings, MEDIA: media })).rejects.toThrow('unknown entry put')
    const key = `project-share/${slug}/pub_1/entry_pub_1/entry.html`
    expect(await bucket.head(key)).not.toBeNull()
    const unrelated = `project-share/${slug}/another/snapshot/archive.zip`
    await bucket.put(unrelated, 'inflight other request')
    await stop({ project_id: 'project_1', publicationId: 'pub_1', previousPublicationId: null, entrySnapshotId: 'entry_pub_1' })
    expect(await bucket.head(key)).toBeNull()
    expect(await bucket.head(unrelated)).not.toBeNull()
    expect((await entry()).status).toBe(410)
  })
  it('rejects internal source aliases and unlisted files without poisoning the next valid snapshot attempt', async () => {
    await entry()
    const source = strToU8('# Hello'), html = strToU8('<p>full</p>'), prefix = '.__notemd-bad_snapshot/'
    const malicious = zipSync({ 'README.md': source, 'unknown.bin': strToU8('not approved'), [prefix + 'reader.html']: html,
      [prefix + 'manifest.json']: strToU8(JSON.stringify({ schemaVersion: 1, project_id: 'project_1', snapshotId: 'bad_snapshot', entry: 'README.md', htmlPath: prefix + 'reader.html', files: [
        { path: 'README.md', hash: await hash(source), bytes: source.length }, { path: prefix + 'reader.html', hash: await hash(html), bytes: html.length },
      ] })),
    })
    expect((await upload(malicious, 'pub_1', 'bad_snapshot')).status).toBe(400)
    expect((await upload(await archive())).status).toBe(200)
  })
  it('serves current R2 HTML through MCP and never falls back to stale KV after revocation', async () => {
    await entry(); await upload(await archive())
    await bindings.SHARES.put(slug, '<p>stale old KV</p>', { metadata: { edit_token: token } })
    async function get() {
      const response = await SELF.fetch('http://x/mcp', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'share_get_html', arguments: { slug } } }) })
      return (await response.json() as any).result
    }
    const result = await get()
    expect(result.isError).not.toBe(true)
    expect(JSON.parse(result.content[0].text).html).toContain('full full_1')
    await stop()
    expect((await get()).isError).toBe(true)
  })
  it.each([true, false])('cleans unknown legacy copy using server-parsed ID (structured=%s) without a local legacy ID', async structured => {
    const oldId = structured ? 'actual_legacy_snapshot' : 'legacy'
    const old = '<p>old</p>' + (structured ? '<script id="project-data" type="application/json">' + JSON.stringify({ snapshot: { project_id: 'project_1', snapshotId: oldId } }) + '</script>' : '')
    await bindings.SHARES.put(slug, old, { metadata: { edit_token: token, project_id: 'project_1', feedback_token_hash: await hash(strToU8('visitor')), expires_at: null } })
    const bucket = bindings.MEDIA
    const media = { get: bucket.get.bind(bucket), head: bucket.head.bind(bucket), delete: bucket.delete.bind(bucket),
      async put(key: string, value: any, options: any) {
        const result = await bucket.put(key, value, options)
        if (key.endsWith('/legacy.html')) throw new Error('unknown legacy put')
        return result
      },
    } as unknown as R2Bucket
    const request = new Request(root + '/entry', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({
      publicationId: 'pub_1', previousPublicationId: null, snapshotId: 'entry_pub_1', project_id: 'project_1', edit_token: token,
      feedback_token_hash: await hash(strToU8('visitor')), html: '<p>entry</p>', entry: 'README.md', title: 'Project', expires_in_seconds: 3600,
    }) })
    await expect(worker.fetch(request, { ...bindings, MEDIA: media })).rejects.toThrow('unknown legacy put')
    const key = `project-share/${slug}/pub_1/${oldId}/legacy.html`
    expect(await bucket.head(key)).not.toBeNull()
    await stop({ project_id: 'project_1', publicationId: 'pub_1', previousPublicationId: null, entrySnapshotId: 'entry_pub_1' })
    expect(await bucket.head(key)).toBeNull()
  })
  it('persists exact late keys on repeated tombstone stop and cleans them on a later retry', async () => {
    const input = { project_id: 'project_1', publicationId: 'pub_1', previousPublicationId: null, entrySnapshotId: 'entry_pub_1' }
    await stop({ project_id: 'project_1', publicationId: 'pub_1', previousPublicationId: null })
    const key = `project-share/${slug}/pub_1/entry_pub_1/entry.html`, bucket = bindings.MEDIA
    await bucket.put(key, 'late put')
    const media = { get: bucket.get.bind(bucket), head: bucket.head.bind(bucket), put: bucket.put.bind(bucket), delete: async () => { throw new Error('cleanup offline') } } as unknown as R2Bucket
    const response = await worker.fetch(new Request('http://x/' + slug, { method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ edit_token: token, ...input }) }), { ...bindings, MEDIA: media })
    expect(response.status).toBe(200)
    expect((await (await bucket.get(projectStateKey(slug)))!.json() as any).cleanup).toContain(key)
    await stop(input)
    expect(await bucket.head(key)).toBeNull()
  })
})
