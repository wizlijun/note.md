import { fetch } from '@tauri-apps/plugin-http'

export type LinuxRelease = { version: string; body: string | null; url: string }

const REPOSITORY = 'https://github.com/wizlijun/note.md'
const RELEASES_API = 'https://api.github.com/repos/wizlijun/note.md/releases'
const PAGE_SIZE = 100
const TIMEOUT_MS = 20_000

function linuxArchitecture(triple: string) {
  if (triple === 'x86_64-unknown-linux-gnu') return { arch: 'x86_64', deb: 'amd64' }
  if (triple === 'aarch64-unknown-linux-gnu') return { arch: 'aarch64', deb: 'arm64' }
  throw new Error(`Unsupported Linux update target: ${triple}`)
}

export function linuxUpdateStoreName(triple: string): string {
  linuxArchitecture(triple)
  return `linux-updater-${triple}.json`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Discover metadata only. Installation remains with the user's package manager.
export async function checkLinuxRelease(triple: string): Promise<LinuxRelease | null> {
  const architecture = linuxArchitecture(triple)
  const controller = new AbortController()
  const deadline = Date.now() + TIMEOUT_MS
  const timeoutError = () => new Error('Linux update check timed out after 20 seconds')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(timeoutError())
    }, TIMEOUT_MS)
  })

  async function lookup(): Promise<LinuxRelease | null> {
    for (let page = 1; ; page++) {
      if (controller.signal.aborted || Date.now() >= deadline) throw timeoutError()
      const response = await fetch(`${RELEASES_API}?per_page=${PAGE_SIZE}&page=${page}`, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'note.md-linux-updates' },
        signal: controller.signal,
        connectTimeout: Math.max(1, deadline - Date.now()),
        maxRedirections: 0,
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new Error(`GitHub releases request failed: HTTP ${response.status}`)
      }
      let releases: unknown
      try {
        releases = await response.json()
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('Invalid JSON in GitHub releases response')
        throw error
      }
      if (controller.signal.aborted || Date.now() >= deadline) throw timeoutError()
      if (!Array.isArray(releases) || !releases.every(isRecord)) {
        throw new Error('Invalid GitHub releases response: expected a release array')
      }
      for (const release of releases) {
        if (typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean'
          || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
          throw new Error('Invalid GitHub releases response: malformed release metadata')
        }
        if (release.draft || release.prerelease
          || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) continue
        const version = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.tag_name)?.[1]
        if (!version || !version.split('.').every(part => Number.isSafeInteger(Number(part)))) continue
        const debName = `note.md_${version}_${architecture.deb}.deb`
        const escapedVersion = version.replaceAll('.', '\\.')
        const archName = new RegExp(`^notemd-${escapedVersion}-[1-9]\\d*-${architecture.arch}\\.pkg\\.tar\\.zst$`)
        const available = release.assets.some((asset: unknown) => isRecord(asset)
          && typeof asset.name === 'string' && (asset.name === debName || archName.test(asset.name))
          && asset.state === 'uploaded' && typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0
          && asset.browser_download_url === `${REPOSITORY}/releases/download/${release.tag_name}/${asset.name}`)
        if (available) return {
          version,
          body: typeof release.body === 'string' ? release.body : null,
          url: `${REPOSITORY}/releases/tag/${release.tag_name}`,
        }
      }
      if (releases.length < PAGE_SIZE) return null
    }
  }

  try {
    // The race bounds the complete lookup even if the native transport stalls
    // before registering abort, or while reading a response body.
    return await Promise.race([lookup(), timeout])
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError()
    throw new Error(`Linux update check failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}
