import { ShareError, type ShareSettings } from './types'
import { getPluginScopedKey } from '../settings.svelte'

let testSettings: ShareSettings | null = null

/** Test seam: bypass settings.svelte storage. */
export function _setSettingsForTests(s: ShareSettings | null) {
  testSettings = s
}

function getSettings(): ShareSettings {
  if (testSettings !== null) return testSettings
  return {
    baseUrl: getPluginScopedKey('share.baseUrl') as string | undefined,
    apiKey: getPluginScopedKey('share.apiKey') as string | undefined,
    defaultExpiry: getPluginScopedKey('share.defaultExpiry') as ShareSettings['defaultExpiry'],
    slugRandomSuffix: getPluginScopedKey('share.slugRandomSuffix') as boolean | undefined,
  }
}

function buildUrl(path: string): { url: string; apiKey: string } {
  const cfg = getSettings()
  if (!cfg.baseUrl || !cfg.apiKey) throw new ShareError('not_configured')
  const base = cfg.baseUrl.replace(/\/+$/, '')
  return { url: base + path, apiKey: cfg.apiKey }
}

async function call(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<any> {
  const { url, apiKey } = buildUrl(path)
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    throw new ShareError('network', e instanceof Error ? e.message : String(e))
  }
  if (res.ok) {
    try { return await res.json() } catch { return {} }
  }
  if (res.status === 401) throw new ShareError('auth')
  if (res.status === 403) throw new ShareError('forbidden')
  if (res.status === 404 && method === 'DELETE') return { ok: true }
  if (res.status === 409) throw new ShareError('conflict')
  if (res.status === 413) throw new ShareError('too_large')
  if (res.status === 415) throw new ShareError('unsupported')
  if (res.status >= 500) throw new ShareError('server', `HTTP ${res.status} ${res.statusText}`)
  throw new ShareError('http', `HTTP ${res.status} ${res.statusText}`)
}

export const post = (path: string, body: unknown) => call('POST', path, body)
export const del  = (path: string, body: unknown) => call('DELETE', path, body)

/** Raw POST for image upload (binary body, custom headers). */
export async function postBytes(
  path: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
  extraHeaders: Record<string, string>,
): Promise<any> {
  const { url, apiKey } = buildUrl(path)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': contentType,
        ...extraHeaders,
      },
      body: bytes as BodyInit,
    })
  } catch (e) {
    throw new ShareError('network', e instanceof Error ? e.message : String(e))
  }
  if (res.ok) {
    try { return await res.json() } catch (e) {
      throw new ShareError('parse', e instanceof Error ? e.message : String(e))
    }
  }
  if (res.status === 401) throw new ShareError('auth')
  if (res.status === 413) throw new ShareError('too_large')
  if (res.status === 415) throw new ShareError('unsupported')
  if (res.status >= 500) throw new ShareError('server', `HTTP ${res.status} ${res.statusText}`)
  throw new ShareError('http', `HTTP ${res.status} ${res.statusText}`)
}
