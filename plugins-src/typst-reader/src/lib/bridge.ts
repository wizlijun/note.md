export interface TypesetDocument {
  uri: string
  content: string
  requestId: number
}

export interface RenderResult {
  cache_key: string
  page_count: number
  hit: boolean
  complete: boolean
  busy: boolean
}

export type BookStyleRule = 'auto' | 'wonderous-book' | 'aiwriter-book'

interface HostBridge {
  locale: string
  request(method: string, params?: unknown): Promise<any>
}

function host(): HostBridge {
  const value = (window as Window & { notemd?: HostBridge }).notemd
  if (!value) throw new Error('Typeset Reader host bridge is unavailable')
  return value
}

export function locale(): string { return host().locale }

export function isHostOrigin(origin: string): boolean {
  return origin === 'tauri://localhost' || /^https?:\/\/tauri\.localhost$/.test(origin)
    || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)
}

export function onDocument(callback: (document: TypesetDocument) => void): () => void {
  const receive = (event: MessageEvent) => {
    const data = event.data
    if (event.source !== window.parent || !isHostOrigin(event.origin) || !data
      || data.type !== 'file_view.open' || data.viewId !== 'typeset'
      || !Number.isSafeInteger(data.requestId) || typeof data.content !== 'string'
      || typeof data.uri !== 'string' || !data.uri.endsWith('.typeset.md')) return
    // A book can take longer than the host's fixed file-view deadline to
    // compile. Acknowledge the valid snapshot first; the view owns progress
    // and errors from this point on.
    window.parent.postMessage({ type: 'file_view.ready', requestId: data.requestId }, event.origin)
    callback({ uri: data.uri, content: data.content, requestId: data.requestId })
  }
  window.addEventListener('message', receive)
  return () => {
    window.removeEventListener('message', receive)
  }
}

function validBookStyleRule(value: unknown): value is BookStyleRule {
  return value === 'auto' || value === 'wonderous-book' || value === 'aiwriter-book'
}

function validateRenderResult(result: any, cacheKey?: string): RenderResult {
  if (typeof result?.cache_key !== 'string' || (cacheKey !== undefined && result.cache_key !== cacheKey)
    || !Number.isSafeInteger(result.page_count) || result.page_count < 0
    || typeof result.hit !== 'boolean' || typeof result.complete !== 'boolean'
    || typeof result.busy !== 'boolean') {
    throw new Error('The renderer returned invalid progress.')
  }
  return result
}

export async function loadBookStyleRule(): Promise<BookStyleRule> {
  const result = await host().request('host.settings.get')
  const value = result?.settings?.bookStyle
  return validBookStyleRule(value) ? value : 'auto'
}

export async function saveBookStyleRule(value: BookStyleRule): Promise<void> {
  if (!validBookStyleRule(value)) throw new Error('Invalid typesetting template rule.')
  await host().request('host.settings.set', { key: 'bookStyle', value })
}

export async function renderDocument(document: TypesetDocument, bookStyle: BookStyleRule): Promise<RenderResult> {
  const vault = await host().request('host.vault.info')
  if (typeof vault?.root !== 'string' || !vault.root) throw new Error('Open a Vault first.')
  const result = await host().request('plugin.render', {
    uri: document.uri,
    content: document.content,
    vault_root: vault.root,
    book_style: bookStyle,
  })
  return validateRenderResult(result)
}

export async function renderNext(cacheKey: string): Promise<RenderResult> {
  const result = await host().request('plugin.render-next', { cache_key: cacheKey })
  const progress = validateRenderResult(result, cacheKey)
  if (progress.hit !== false || (progress.complete && progress.busy)) {
    throw new Error('The renderer returned invalid progress.')
  }
  return progress
}

export async function loadPage(cacheKey: string, page: number): Promise<string> {
  const result = await host().request('plugin.page', { cache_key: cacheKey, page })
  if (typeof result?.svg !== 'string' || !result.svg.startsWith('<svg')) {
    throw new Error('The renderer returned an invalid page.')
  }
  return result.svg
}
