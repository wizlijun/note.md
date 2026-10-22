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

async function downloadWith({ url = 'https://notemd.net/download?format=deb', ua = '', headers = {}, pages = [], cached = {}, unavailable = false }: {
  url?: string, ua?: string, headers?: Record<string, string>, pages?: unknown[][], cached?: Record<string, string>, unavailable?: boolean
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
  const response = await worker.fetch(new Request(url, { headers: { 'User-Agent': ua, ...headers } }),
    { ASSETS: { fetch: vi.fn() } }, { waitUntil: (p: Promise<unknown>) => pending.push(p) })
  await Promise.all(pending)
  return { response, cache }
}

const linuxRelease = { draft: false, prerelease: false, assets: [
  { name: 'note.md_6.1015.2_amd64.deb', browser_download_url: LINUX_AMD64 },
  { name: 'note.md_6.1015.2_arm64.deb', browser_download_url: LINUX_ARM64 },
] }

describe('Linux /download worker route', () => {
  const reducedUa = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'

  it('requests missing hints and offers an explicit choice instead of cached AMD64', async () => {
    const { response } = await downloadWith({ ua: reducedUa,
      cached: { 'dl/linux-deb-x86_64': LINUX_AMD64, 'dl-lkg/linux-deb-x86_64': LINUX_AMD64 } })
    expect(response.status).toBe(200)
    expect(response.headers.get('Location')).toBeNull()
    expect(response.headers.get('Accept-CH')).toBe('Sec-CH-UA-Arch, Sec-CH-UA-Bitness')
    expect(response.headers.get('Critical-CH')).toBe(response.headers.get('Accept-CH'))
    expect(response.headers.get('Vary')).toContain('Sec-CH-UA-Arch')
    expect(response.headers.get('Vary')).toContain('Sec-CH-UA-Bitness')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('/download?os=linux&amp;format=deb&amp;arch=aarch64')
    expect(html).toContain('/download?os=linux&amp;format=deb&amp;arch=x86_64')
  })

  it.each([
    { arch: '"arm"', want: LINUX_ARM64 },
    { arch: '"x86"', want: LINUX_AMD64 },
  ])('uses browser-negotiated $arch with a reduced UA', async ({ arch, want }) => {
    const { response } = await downloadWith({ ua: reducedUa,
      headers: { 'Sec-CH-UA-Arch': arch, 'Sec-CH-UA-Bitness': '"64"' }, pages: [[linuxRelease]] })
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(want)
  })

  it('keeps explicit selection ahead of conflicting hints', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&format=deb&arch=arm64', ua: reducedUa,
      headers: { 'Sec-CH-UA-Arch': '"x86"' }, pages: [[linuxRelease]] })
    expect(response.headers.get('Location')).toBe(LINUX_ARM64)
  })

  it.each(['"arm"', '"x86"'])('does not assume 64 bits from the %s family hint alone', async (arch) => {
    for (const bitness of [null, '', '""', '"32"']) {
      const headers: Record<string, string> = { 'Sec-CH-UA-Arch': arch }
      if (bitness !== null) headers['Sec-CH-UA-Bitness'] = bitness
      const { response } = await downloadWith({ ua: reducedUa, headers,
        cached: { 'dl/linux-deb-x86_64': LINUX_AMD64, 'dl/linux-deb-aarch64': LINUX_ARM64 } })
      expect(response.status).toBe(200)
      expect(response.headers.get('Location')).toBeNull()
    }
  })

  it.each([
    { language: 'zh-CN,zh;q=0.9', title: '选择 Linux 下载版本' },
    { language: 'de-DE,de;q=0.9', title: 'Linux-Download auswählen' },
    { language: 'ja-JP,ja;q=0.9', title: 'Linux 版を選択' },
    { language: 'en-US,en;q=0.9', title: 'Choose your Linux download' },
  ])('offers an accessible choice when hints are unavailable: $language', async ({ language, title }) => {
    const { response } = await downloadWith({ ua: reducedUa, headers: { 'Accept-Language': language }, unavailable: true })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain(`<h1>${title}</h1>`)
  })

  it('requests hints on static pages without altering their content or cache policy', async () => {
    const worker = (await import('./index.js')).default
    const response = await worker.fetch(new Request('https://notemd.net/zh/'), {
      ASSETS: { fetch: async () => new Response('homepage', { headers: { 'Cache-Control': 'public, max-age=60', Vary: 'Accept-Encoding' } }) },
    }, { waitUntil: () => {} })
    expect(await response.text()).toBe('homepage')
    expect(response.headers.get('Accept-CH')).toBe('Sec-CH-UA-Arch, Sec-CH-UA-Bitness')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60')
    expect(response.headers.get('Vary')).toBe('Accept-Encoding')
  })

  it.each([
    { url: 'https://notemd.net/download?format=deb', ua: 'Mozilla/5.0 (X11; Linux x86_64)', want: LINUX_AMD64 },
    { url: 'https://notemd.net/download?format=deb', ua: 'Mozilla/5.0 (X11; Linux aarch64)', want: LINUX_ARM64 },
    { url: 'https://notemd.net/download?os=linux&format=deb&arch=arm64', ua: 'Macintosh', want: LINUX_ARM64 },
  ])('finds the actual package despite a newer mac-only release: $url $ua', async ({ url, ua, want }) => {
    const { response } = await downloadWith({ url, ua, pages: [[{ assets: [] }, linuxRelease]] })
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(want)
  })

  it('paginates when the Linux package is older than the first 100 releases', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&format=deb&arch=amd64', pages: [
      Array.from({ length: 100 }, () => ({ assets: [] })), [linuxRelease],
    ] })
    expect(response.headers.get('Location')).toBe(LINUX_AMD64)
  })

  it('sends native ARM visitors to releases when only an AMD64 package exists', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&format=deb&arch=arm64', pages: [[
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
    const { response } = await downloadWith({ url: `https://notemd.net/download?os=${os}&arch=${arch}&format=deb`,
      unavailable: true, cached: { [`dl-lkg/${os}${os === 'linux' ? '-deb' : ''}-${arch}`]: want } })
    expect(response.headers.get('Location')).toBe(want)
  })

  it('stores each resolved Linux architecture as its own last-known-good download', async () => {
    const { cache } = await downloadWith({ url: 'https://notemd.net/download?os=linux&format=deb&arch=arm64', pages: [[linuxRelease]] })
    expect(await cache.get('https://notemd.net/__cache/dl-lkg/linux-deb-aarch64')?.json()).toEqual({ url: LINUX_ARM64 })
    expect(cache.has('https://notemd.net/__cache/dl-lkg/linux-deb-x86_64')).toBe(false)
  })
})


const MAC_INTEL = 'https://github.com/wizlijun/note.md/releases/download/v6.1015.2/note.md-6.1015.2-x86_64.dmg'

describe('macOS /download worker route', () => {
  it('keeps Apple Silicon on the latest manifest version', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=mac' })
    expect(response.headers.get('Location')).toBe('https://github.com/wizlijun/note.md/releases/download/v6.1015.3/note.md-6.1015.3-aarch64.dmg')
  })

  it('finds and caches a historical Intel dmg when latest is Apple Silicon only', async () => {
    const { response, cache } = await downloadWith({ url: 'https://notemd.net/download?os=mac&arch=intel', pages: [
      Array.from({ length: 100 }, () => ({ assets: [] })),
      [{ assets: [{ name: 'note.md-6.1015.2-x86_64.dmg', browser_download_url: MAC_INTEL }] }],
    ] })
    expect(response.headers.get('Location')).toBe(MAC_INTEL)
    expect(await cache.get('https://notemd.net/__cache/dl-lkg/mac-x86_64')?.json()).toEqual({ url: MAC_INTEL })
  })

  it('uses releases instead of inventing an Intel download when none exists', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=mac&arch=intel' })
    expect(response.headers.get('Location')).toBe('https://github.com/wizlijun/note.md/releases')
  })

  it('uses the Intel last-known-good URL when GitHub is unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=mac&arch=intel',
      unavailable: true, cached: { 'dl-lkg/mac-x86_64': MAC_INTEL } })
    expect(response.headers.get('Location')).toBe(MAC_INTEL)
  })
})


const ARCH_ARM64 = 'https://github.com/wizlijun/note.md/releases/download/v6.1022.1/notemd-6.1022.1-1-aarch64.pkg.tar.zst'
const ARCH_AMD64 = 'https://github.com/wizlijun/note.md/releases/download/v6.1022.1/notemd-6.1022.1-1-x86_64.pkg.tar.zst'
const archRelease = { assets: [
  { name: 'notemd-6.1022.1-1-aarch64.pkg.tar.zst', browser_download_url: ARCH_ARM64 },
  { name: 'notemd-6.1022.1-1-x86_64.pkg.tar.zst', browser_download_url: ARCH_AMD64 },
] }

describe('explicit Linux package format', () => {
  it.each(['', '&format=rpm', '&format=ARCH', '&format=deb%3Cscript%3E'])('requires a format choice without guessing the distribution: %s', async (suffix) => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&arch=aarch64'+suffix,
      cached: { 'dl/linux-aarch64': LINUX_ARM64, 'dl/linux-deb-aarch64': LINUX_ARM64 } })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('/download?os=linux&amp;format=deb&amp;arch=aarch64')
    expect(html).toContain('/download?os=linux&amp;format=arch&amp;arch=aarch64')
    expect(html).toContain('Debian / Ubuntu (.deb)')
    expect(html).toContain('Omarchy / Arch (.pkg.tar.zst)')
    expect(html.indexOf('format=arch')).toBeLessThan(html.indexOf('format=deb'))
    expect(html).toContain('Recommended')
    expect(html).not.toContain('&lt;script&gt;')
  })

  it('preserves the negotiated architecture in format choices', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download',
      ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0',
      headers: { 'Sec-CH-UA-Arch': '"arm"', 'Sec-CH-UA-Bitness': '"64"' } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('/download?os=linux&amp;format=arch&amp;arch=aarch64')
  })

  it('keeps the selected format while asking for an unknown architecture', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&format=arch',
      ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0' })
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('/download?os=linux&amp;format=arch&amp;arch=aarch64')
    expect(html).toContain('/download?os=linux&amp;format=arch&amp;arch=x86_64')
    expect(html).not.toContain('(.deb)')
  })

  it.each([
    { arch: 'aarch64', want: ARCH_ARM64 },
    { arch: 'x86_64', want: ARCH_AMD64 },
  ])('serves the actual $arch Arch package and caches its format independently', async ({ arch, want }) => {
    const { response, cache } = await downloadWith({ url: `https://notemd.net/download?os=linux&format=arch&arch=${arch}`,
      pages: [[linuxRelease, archRelease]], cached: { [`dl/linux-deb-${arch}`]: LINUX_ARM64, [`dl/linux-${arch}`]: LINUX_ARM64 } })
    expect(response.headers.get('Location')).toBe(want)
    expect(await cache.get(`https://notemd.net/__cache/dl-lkg/linux-arch-${arch}`)?.json()).toEqual({ url: want })
  })

  it('does not fall back to Debian or x86_64 when the requested ARM Arch package is missing', async () => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&format=arch&arch=aarch64',
      pages: [[linuxRelease, { assets: [archRelease.assets[1]] }]],
      cached: { 'dl-lkg/linux-aarch64': LINUX_ARM64, 'dl-lkg/linux-deb-aarch64': LINUX_ARM64, 'dl-lkg/linux-arch-x86_64': ARCH_AMD64 } })
    expect(response.headers.get('Location')).toBe('https://github.com/wizlijun/note.md/releases')
  })

  it('uses only the matching format and architecture last-known-good package on upstream failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&format=arch&arch=aarch64', unavailable: true,
      cached: { 'dl-lkg/linux-deb-aarch64': LINUX_ARM64, 'dl-lkg/linux-arch-aarch64': ARCH_ARM64 } })
    expect(response.headers.get('Location')).toBe(ARCH_ARM64)
  })
})


describe('Omarchy installation instructions', () => {
  it.each([
    { language: 'en', instruction: 'Install in a terminal:' },
    { language: 'zh', instruction: '终端安装：' },
    { language: 'de', instruction: 'Im Terminal installieren:' },
    { language: 'ja', instruction: 'ターミナルでインストール：' },
  ])('explains terminal installation for $language without hardcoding a package filename', async ({ language, instruction }) => {
    const { response } = await downloadWith({ url: 'https://notemd.net/download?os=linux&arch=aarch64', headers: { 'Accept-Language': language } })
    const html = await response.text()
    expect(html).toContain(instruction)
    expect(html).toContain('sudo pacman -U &lt;')
    expect(html).not.toContain('*.pkg.tar.zst')
    expect(html).not.toContain('notemd-6.')
  })
})
