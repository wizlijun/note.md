import { afterEach, describe, expect, it, vi } from 'vitest'

const WINDOWS_INSTALLER =
  'https://github.com/wizlijun/note.md/releases/download/v6.811.1/note.md_6.811.1_x64-setup.exe'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('/download worker route', () => {
  it('redirects Windows visitors to the newest available installer when latest.json is mac-only', async () => {
    const cache = new Map<string, Response>()
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async (request: Request) => cache.get(request.url)?.clone()),
        put: vi.fn(async (request: Request, response: Response) => {
          cache.set(request.url, response.clone())
        }),
      },
    })
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/releases/latest/download/latest.json')) {
        return Response.json({
          version: '6.829.2',
          platforms: {
            'darwin-aarch64': {
              url: 'https://github.com/wizlijun/note.md/releases/download/v6.829.2/note.md-aarch64.app.tar.gz',
            },
          },
        })
      }
      if (url.endsWith('/releases?per_page=100&page=1')) {
        return Response.json([
          {
            tag_name: 'v6.811.1',
            draft: false,
            prerelease: false,
            assets: [{ name: 'note.md_6.811.1_x64-setup.exe', browser_download_url: WINDOWS_INSTALLER }],
          },
        ])
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const worker = (await import('./index.js')).default
    const pending: Promise<unknown>[] = []
    const response = await worker.fetch(
      new Request('https://notemd.net/download?os=windows', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      }),
      { ASSETS: { fetch: vi.fn() } },
      { waitUntil: (promise: Promise<unknown>) => pending.push(promise) },
    )
    await Promise.all(pending)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(WINDOWS_INSTALLER)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})


const LINUX_AMD64 = 'https://github.com/wizlijun/note.md/releases/download/v6.1015.2/note.md_6.1015.2_amd64.deb'
const LINUX_ARM64 = 'https://github.com/wizlijun/note.md/releases/download/v6.1015.2/note.md_6.1015.2_arm64.deb'

async function downloadWith({ url = 'https://notemd.net/download', ua = '', pages = [], cached = {}, unavailable = false }: {
  url?: string, ua?: string, pages?: unknown[][], cached?: Record<string, string>, unavailable?: boolean
}) {
  const cache = new Map<string, Response>(Object.entries(cached).map(([key, value]) => [
    `https://notemd.net/__cache/${key}`, Response.json({ url: value }, { headers: { 'Cache-Control': 'public, max-age=2592000' } }),
  ]))
  vi.stubGlobal('caches', { default: {
    match: async (request: Request) => cache.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => { cache.set(request.url, response.clone()) },
  } })
  vi.stubGlobal('fetch', async (input: string) => {
    if (unavailable) return new Response(null, { status: 503 })
    if (input.includes('/latest/download/latest.json')) return Response.json({ version: '6.1015.3', platforms: {
      'darwin-aarch64': { url: 'https://github.com/wizlijun/note.md/releases/download/v6.1015.3/note.md-aarch64.app.tar.gz' },
    } })
    const page = new URL(input).searchParams.get('page')
    if (page) return Response.json(pages[Number(page) - 1] ?? [])
    throw new Error('Unexpected upstream URL')
  })
  const worker = (await import('./index.js')).default
  const pending: Promise<unknown>[] = []
  const response = await worker.fetch(new Request(url, { headers: { 'User-Agent': ua } }),
    { ASSETS: { fetch: vi.fn() } }, { waitUntil: (p: Promise<unknown>) => pending.push(p) })
  await Promise.all(pending)
  return { response, cache }
}

const linuxRelease = { draft: false, prerelease: false, assets: [
  { name: 'note.md_6.1015.2_amd64.deb', browser_download_url: LINUX_AMD64 },
  { name: 'note.md_6.1015.2_arm64.deb', browser_download_url: LINUX_ARM64 },
] }

describe('Linux /download worker route', () => {
  it.each([
    { url: 'https://notemd.net/download', ua: 'Mozilla/5.0 (X11; Linux x86_64)', want: LINUX_AMD64 },
    { url: 'https://notemd.net/download', ua: 'Mozilla/5.0 (X11; Linux aarch64)', want: LINUX_ARM64 },
    { url: 'https://notemd.net/download?os=linux&arch=arm64', ua: 'Macintosh', want: LINUX_ARM64 },
  ])('finds the actual package despite a newer mac-only release: $url $ua', async ({ url, ua, want }) => {
    const { response } = await downloadWith({ url, ua, pages: [[{ assets: [] }, linuxRelease]] })
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(want)
  })

  it('paginates when the Linux package is older than the first 100 releases', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&arch=amd64', pages: [
      Array.from({ length: 100 }, () => ({ assets: [] })), [linuxRelease],
    ] })
    expect(response.headers.get('Location')).toBe(LINUX_AMD64)
  })

  it('sends native ARM visitors to releases when only an AMD64 package exists', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&arch=arm64', pages: [[
      { assets: [linuxRelease.assets[0]] },
    ]] })
    expect(response.headers.get('Location')).toBe('https://github.com/wizlijun/note.md/releases')
  })

  it.each([
    { os: 'linux', arch: 'x86_64', want: LINUX_AMD64 },
    { os: 'linux', arch: 'aarch64', want: LINUX_ARM64 },
    { os: 'windows', arch: 'x86_64', want: WINDOWS_INSTALLER },
  ])('uses the $os $arch last-known-good URL when GitHub is unavailable', async ({ os, arch, want }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { response } = await downloadWith({ url: `https://notemd.net/download?os=${os}&arch=${arch}`,
      unavailable: true, cached: { [`dl-lkg/${os}-${arch}`]: want } })
    expect(response.headers.get('Location')).toBe(want)
  })

  it('stores each resolved Linux architecture as its own last-known-good download', async () => {
    const { cache } = await downloadWith({ url: 'https://notemd.net/download?os=linux&arch=arm64', pages: [[linuxRelease]] })
    expect(await cache.get('https://notemd.net/__cache/dl-lkg/linux-aarch64')?.json()).toEqual({ url: LINUX_ARM64 })
    expect(cache.has('https://notemd.net/__cache/dl-lkg/linux-x86_64')).toBe(false)
  })
})
