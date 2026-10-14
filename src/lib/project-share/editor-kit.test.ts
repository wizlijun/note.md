import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { ensureProjectEditorKit, installedProjectEditorKit, type KitManifest } from './editor-kit'
const files: Record<string, Uint8Array> = {}
function asset(text: string, ext: string, mermaid = false) {
  const bytes = new TextEncoder().encode(text), sha256 = createHash('sha256').update(bytes).digest('hex')
  const name = `share-editor${mermaid ? '-mermaid' : ''}.${sha256}.${ext}`; files[name] = bytes
  return { name, sha256, sri: 'sha384-' + createHash('sha384').update(bytes).digest('base64') }
}
const manifest: KitManifest = { apiVersion: 1, js: asset('real js', 'js'), css: asset('real css', 'css'), mermaid: asset('real mermaid', 'js', true) }
vi.mock('virtual:share-editor-kit', () => ({ default: manifest, assetUrls: Object.fromEntries(Object.keys(files).map(name => [name, 'http://tauri.localhost/assets/' + name])) }))
const fetchMock = vi.fn()
const input = () => ({ origin: 'https://share.test', apiKey: 'PRIVATE_KEY', manifest, readAsset: vi.fn(async (name: string) => files[name]) })
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
describe('editor kit owner delivery', () => {
  it('verifies all local bytes first, HEADs public names and PUTs only missing exact resources', async () => {
    const config = input()
    fetchMock.mockImplementation(async (_url, init) => {
      expect(config.readAsset).toHaveBeenCalledTimes(3)
      return new Response(null, { status: init.method === 'HEAD' ? 404 : 201 })
    })
    const result = await ensureProjectEditorKit(config)
    expect(result.warnings).toEqual([])
    for (const kind of ['js', 'css', 'mermaid'] as const) {
      const asset = manifest[kind]!, url = `https://share.test/_kit/${asset.name}`
      expect(result.editorKit?.[kind]).toEqual({ url, integrity: asset.sri })
      expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'PUT', body: files[asset.name], headers: expect.objectContaining({ Authorization: 'Bearer PRIVATE_KEY' }), redirect: 'error' }))
    }
    expect(JSON.stringify(result)).not.toContain('PRIVATE_KEY')
  })
  it('accepts existing resources without PUT and fails closed on non-404 HEAD or failed PUT', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))
    expect((await ensureProjectEditorKit(input())).editorKit).toBeDefined()
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'HEAD')).toBe(true)
    for (const status of [401, 500]) {
      fetchMock.mockReset().mockResolvedValue(new Response('PRIVATE_KEY /local/path', { status }))
      const result = await ensureProjectEditorKit(input())
      expect(result.editorKit).toBeUndefined(); expect(result.warnings).toHaveLength(1)
      expect(result.warnings.join('')).not.toMatch(/PRIVATE_KEY|local\/path/)
    }
    fetchMock.mockReset().mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(null, { status: 500 }))
    expect((await ensureProjectEditorKit(input())).warnings).toHaveLength(1)
  })
  it('rejects local tampering, unsafe names, wrong SRI and read failure before any network request', async () => {
    for (const config of [
      { ...input(), readAsset: async () => new Uint8Array([0]) },
      { ...input(), manifest: { ...manifest, css: { ...manifest.css, name: '../local.css' } } },
      { ...input(), manifest: { ...manifest, css: { ...manifest.css, sri: manifest.js.sri } } },
      { ...input(), readAsset: async () => { throw new Error('PRIVATE_KEY') } },
      { ...input(), origin: 'https://owner:password@share.test' },
    ]) {
      const result = await ensureProjectEditorKit(config)
      expect(result.editorKit).toBeUndefined(); expect(result.warnings).toHaveLength(1)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})


it('reads installed same-origin static bytes, checks them, then uploads to the share origin', async () => {
  vi.stubGlobal('window', { location: { href: 'http://tauri.localhost/index.html' } })
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    if (url.startsWith('http://tauri.localhost/assets/')) {
      expect(init.headers).toBeUndefined()
      return new Response(new Uint8Array(files[url.split('/').at(-1)!]))
    }
    return new Response(null, { status: init.method === 'HEAD' ? 404 : 201 })
  })
  expect((await installedProjectEditorKit('https://share.test', 'PRIVATE_KEY')).editorKit?.js.url).toBe(`https://share.test/_kit/${manifest.js.name}`)
  expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('http://tauri.localhost/assets/'))).toHaveLength(3)
  vi.stubGlobal('window', { location: { href: 'https://other.test/index.html' } })
  fetchMock.mockClear()
  expect((await installedProjectEditorKit('https://share.test', 'PRIVATE_KEY')).warnings).toHaveLength(1)
  expect(fetchMock).not.toHaveBeenCalled()
})
