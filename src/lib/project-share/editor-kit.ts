export interface KitAsset { name: string; sha256: string; sri: string }
export interface KitManifest { apiVersion: 1; js: KitAsset; css: KitAsset; mermaid?: KitAsset }
export interface EditorKitDescriptor {
  apiVersion: 1
  js: { url: string; integrity: string }
  css: { url: string; integrity: string }
  mermaid?: { url: string; integrity: string }
}
const WARNING = '增强编辑器资源不可用，本轮分享使用基础编辑。'
const MAX_BYTES = 8 * 1024 * 1024
async function digest(bytes: Uint8Array, algorithm: 'SHA-256' | 'SHA-384') {
  return new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(bytes)))
}
export async function ensureProjectEditorKit(input: {
  origin: string; apiKey: string; manifest: KitManifest; readAsset: (name: string) => Promise<Uint8Array>
}): Promise<{ editorKit?: EditorKitDescriptor; warnings: string[] }> {
  try {
    const origin = new URL(input.origin)
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Invalid origin')
    const manifest = structuredClone(input.manifest)
    if (manifest.apiVersion !== 1 || !manifest.js || !manifest.css) throw new Error('Invalid manifest')
    const resources: { kind: 'js' | 'css' | 'mermaid'; bytes: Uint8Array; url: string; integrity: string }[] = []
    // Verify the entire local closure before any authenticated network operation.
    for (const kind of ['js', 'css', 'mermaid'] as const) {
      const asset = manifest[kind]
      if (!asset) continue
      const extension = kind === 'css' ? 'css' : 'js'
      if (!new RegExp(`^share-editor${kind === 'mermaid' ? '-mermaid' : ''}\\.[a-f0-9]{64}\\.${extension}$`).test(asset.name)) throw new Error('Invalid resource name')
      const bytes = new Uint8Array(await input.readAsset(asset.name))
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Invalid resource size')
      const sha256 = [...await digest(bytes, 'SHA-256')].map(x => x.toString(16).padStart(2, '0')).join('')
      const sri = 'sha384-' + btoa(String.fromCharCode(...await digest(bytes, 'SHA-384')))
      if (sha256 !== asset.sha256 || !asset.name.includes(`.${sha256}.`) || sri !== asset.sri) throw new Error('Resource integrity mismatch')
      resources.push({ kind, bytes, url: `${origin.origin}/_kit/${asset.name}`, integrity: sri })
    }
    for (const resource of resources) {
      const head = await fetch(resource.url, { method: 'HEAD', redirect: 'error' })
      if (head.status === 200) continue
      if (head.status !== 404) throw new Error('Resource unavailable')
      const put = await fetch(resource.url, { method: 'PUT', redirect: 'error',
        headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(resource.bytes) })
      if (put.status !== 200 && put.status !== 201) throw new Error('Resource upload failed')
    }
    const descriptor = Object.fromEntries(resources.map(({ kind, url, integrity }) => [kind, { url, integrity }]))
    return { editorKit: { apiVersion: 1, ...descriptor } as EditorKitDescriptor, warnings: [] }
  } catch { return { warnings: [WARNING] } }
}

/** Vite emits this manifest and its exact bytes inside the installed app. */
export async function installedProjectEditorKit(origin: string, apiKey: string): Promise<{ editorKit?: EditorKitDescriptor; warnings: string[] }> {
  try {
    const { default: manifest, assetUrls } = await import('virtual:share-editor-kit')
    return await ensureProjectEditorKit({ origin: new URL(origin).origin, apiKey, manifest, readAsset: async name => {
      const url = new URL(assetUrls[name], window.location.href)
      const app = new URL(window.location.href)
      if (url.protocol !== app.protocol || url.host !== app.host || url.username || url.password) throw new Error('Invalid installed asset URL')
      const response = await fetch(url.href, { redirect: 'error' })
      if (!response.ok) throw new Error('Installed asset unavailable')
      return new Uint8Array(await response.arrayBuffer())
    } })
  } catch { return { warnings: [WARNING] } }
}
