import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkLinuxRelease, linuxUpdateStoreName } from './linux-updates'

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch }))

const X64 = 'x86_64-unknown-linux-gnu'
const ARM = 'aarch64-unknown-linux-gnu'
const REPO = 'https://github.com/wizlijun/note.md'
const API = 'https://api.github.com/repos/wizlijun/note.md/releases?per_page=100&page='

function asset(version: string, name = `note.md_${version}_amd64.deb`) {
  return { name, state: 'uploaded', size: 1024, browser_download_url: `${REPO}/releases/download/v${version}/${name}` }
}

function release(version: string, assets: unknown[] = [asset(version)]) {
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-11-10T06:07:43Z', body: 'Release notes', assets }
}

function respond(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => { fetch.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('Linux release discovery', () => {
  it('skips a newer Mac-only release and returns the canonical page, never the binary URL', async () => {
    fetch.mockResolvedValue(respond([
      release('6.1111.1', [asset('6.1111.1', 'note.md-6.1111.1-aarch64.dmg')]),
      { ...release('6.1110.2'), html_url: 'https://untrusted.example/release' },
    ]))
    expect(await checkLinuxRelease(X64)).toEqual({ version: '6.1110.2', body: 'Release notes', url: `${REPO}/releases/tag/v6.1110.2` })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe(API + '1')
    const options = fetch.mock.calls[0][1]
    expect(new Headers(options.headers).has('Authorization')).toBe(false)
    expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    [ARM, 'arm64', 'aarch64'],
    [X64, 'amd64', 'x86_64'],
  ])('matches only the actual %s architecture, supporting either package format', async (triple, debArch, arch) => {
    const other = arch === 'aarch64' ? 'amd64' : 'arm64'
    fetch.mockResolvedValueOnce(respond([
      release('6.1111.1', [asset('6.1111.1', `note.md_6.1111.1_${other}.deb`)]),
      release('6.1110.2', [asset('6.1110.2', `note.md_6.1110.2_${debArch}.deb`)]),
    ]))
    expect((await checkLinuxRelease(triple))?.version).toBe('6.1110.2')
    fetch.mockResolvedValueOnce(respond([release('6.1110.2', [asset('6.1110.2', `notemd-6.1110.2-2-${arch}.pkg.tar.zst`)])]))
    expect((await checkLinuxRelease(triple))?.version).toBe('6.1110.2')
  })

  it.each([
    { draft: true }, { prerelease: true }, { published_at: null }, { published_at: '' },
    { published_at: 'not a date' }, { tag_name: '6.1110.2' }, { tag_name: 'v6.1110.2-beta.1' },
    { tag_name: 'v6.1110.2+build' }, { tag_name: 'v06.1110.2' },
  ])('ignores unpublished/nonstable releases: %j', async (overrides) => {
    fetch.mockResolvedValue(respond([{ ...release('6.1110.2'), ...overrides }]))
    expect(await checkLinuxRelease(X64)).toBeNull()
  })

  it.each([
    { name: 'fcitx5-sumi-candidates-5.1.23-1-x86_64.pkg.tar.zst' },
    { name: 'note.md_6.1110.1_amd64.deb' },
    { name: 'notemd-6.1110.2-0-x86_64.pkg.tar.zst' },
    { name: 'notemd-6x1110x2-1-x86_64.pkg.tar.zst' },
    { name: 'notemd-6.1110.2-1-x86_64.pkg.tar.zst.sig' },
    { state: 'new' }, { size: 0 }, { size: -1 }, { size: '1024' },
    { browser_download_url: 'http://github.com/wizlijun/note.md/releases/download/v6.1110.2/note.md_6.1110.2_amd64.deb' },
    { browser_download_url: `${REPO}/releases/download/v6.1110.1/note.md_6.1110.2_amd64.deb` },
    { browser_download_url: 'https://github.com/other/note.md/releases/download/v6.1110.2/note.md_6.1110.2_amd64.deb' },
    { browser_download_url: `${REPO}/releases/download/v6.1110.2/note.md_6.1110.2_amd64.deb?download=1` },
  ])('rejects addon, wrong version, unavailable or noncanonical assets: %j', async (overrides) => {
    const candidate = { ...asset('6.1110.2'), ...overrides }
    if ('name' in overrides) candidate.browser_download_url = `${REPO}/releases/download/v6.1110.2/${overrides.name}`
    fetch.mockResolvedValue(respond([release('6.1110.2', [candidate])]))
    expect(await checkLinuxRelease(X64)).toBeNull()
  })

  it('walks full pages and normalizes non-string notes to null', async () => {
    fetch.mockResolvedValueOnce(respond(Array.from({ length: 100 }, () => release('6.1111.1', []))))
      .mockResolvedValueOnce(respond([{ ...release('6.1110.2'), body: { text: 'wrong shape' } }]))
    expect(await checkLinuxRelease(X64)).toEqual({ version: '6.1110.2', body: null, url: `${REPO}/releases/tag/v6.1110.2` })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([API + '1', API + '2'])
  })

  it('returns no matching release only after an actual short or empty page', async () => {
    fetch.mockResolvedValueOnce(respond(Array.from({ length: 100 }, () => release('6.1111.1', []))))
      .mockResolvedValueOnce(respond([]))
    expect(await checkLinuxRelease(ARM)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([404, 403, 429, 500])('reports HTTP %i as an error, not no update', async (status) => {
    fetch.mockResolvedValue(respond({ message: 'upstream failed' }, status))
    await expect(checkLinuxRelease(X64)).rejects.toThrow(String(status))
  })

  it.each([null, {}, { message: 'unexpected response' }, 'unexpected', [null], [{}]].map(body => ({ body })))('rejects an invalid API body: $body', async ({ body }) => {
    fetch.mockResolvedValue(respond(body))
    await expect(checkLinuxRelease(X64)).rejects.toThrow(/invalid.*response/i)
  })

  it('reports malformed JSON and transport errors explicitly', async () => {
    fetch.mockResolvedValueOnce(new Response('not JSON'))
    await expect(checkLinuxRelease(X64)).rejects.toThrow(/JSON/i)
    fetch.mockRejectedValueOnce(new Error('network unavailable'))
    await expect(checkLinuxRelease(X64)).rejects.toThrow(/network unavailable/)
    fetch.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error('body connection interrupted') } })
    await expect(checkLinuxRelease(X64)).rejects.toThrow(/body connection interrupted/)
  })

  it('applies one total deadline across pages and aborts a pending response body', async () => {
    vi.useFakeTimers()
    fetch.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 15_000))
      return respond(Array.from({ length: 100 }, () => release('6.1111.1', [])))
    }).mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) })
    const result = checkLinuxRelease(X64).catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await result).toEqual(expect.objectContaining({ message: expect.stringMatching(/timed out/i) }))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('Linux cache identity', () => {
  it('isolates both Linux triples from each other and the direct updater store', () => {
    expect(linuxUpdateStoreName(X64)).toBe(`linux-updater-${X64}.json`)
    expect(linuxUpdateStoreName(ARM)).toBe(`linux-updater-${ARM}.json`)
  })

  it.each(['', 'aarch64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-musl', '../x86_64'])('rejects unsupported identity %j before a network request', async triple => {
    expect(() => linuxUpdateStoreName(triple)).toThrow(/unsupported.*Linux/i)
    await expect(checkLinuxRelease(triple)).rejects.toThrow(/unsupported.*Linux/i)
    expect(fetch).not.toHaveBeenCalled()
  })
})
