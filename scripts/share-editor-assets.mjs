import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

/** Read before Vite empties dist; emit the exact previously frozen bytes. */
export function shareEditorAssets({ test = false } = {}) {
  const id = 'virtual:share-editor-kit', resolved = '\0' + id
  let frozen
  let command
  function read() {
    if (frozen) return frozen
    const directory = resolve('dist')
    const manifestBytes = readFileSync(join(directory, 'share-editor-manifest.json'))
    const manifest = JSON.parse(manifestBytes.toString())
    if (manifest.apiVersion !== 1 || !manifest.js || !manifest.css) throw new Error('Missing share editor manifest')
    const assets = Object.entries(manifest).filter(([key]) => key !== 'apiVersion').map(([kind, asset]) => {
      if (!new RegExp(`^share-editor${kind === 'mermaid' ? '-mermaid' : ''}\\.[a-f0-9]{64}\\.${kind === 'css' ? 'css' : 'js'}$`).test(asset.name)) throw new Error('Invalid share editor asset')
      const bytes = readFileSync(join(directory, 'assets', asset.name))
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (hash !== asset.sha256 || !asset.name.includes(`.${hash}.`) || asset.sri !== 'sha384-' + createHash('sha384').update(bytes).digest('base64')) throw new Error('Share editor asset hash/SRI mismatch')
      return { ...asset, bytes }
    })
    frozen = { manifest, manifestBytes, assets }
    return frozen
  }
  return {
    name: 'share-editor-assets',
    configResolved(config) { command = config.command },
    resolveId(source) { if (source === id) return resolved },
    buildStart() {
      if (!test && command === 'build') for (const asset of read().assets) {
        asset.referenceId = this.emitFile({ type: 'asset', fileName: 'assets/' + asset.name, source: asset.bytes })
      }
    },
    load(source) {
      if (source !== resolved) return
      if (test) return 'export default undefined; export const assetUrls = {}'
      const { manifest, assets } = read()
      if (command === 'serve') return `export default ${JSON.stringify(manifest)}; export const assetUrls = ${JSON.stringify(Object.fromEntries(assets.map(asset => [asset.name, '/@fs/' + resolve('dist/assets', asset.name)])))}`
      const urls = assets.map(asset => `${JSON.stringify(asset.name)}:import.meta.ROLLUP_FILE_URL_${asset.referenceId}`)
      return `export default ${JSON.stringify(manifest)}; export const assetUrls = {${urls.join(',')}}`
    },
    generateBundle() {
      if (test) return
      const { manifestBytes } = read()
      this.emitFile({ type: 'asset', fileName: 'share-editor-manifest.json', source: manifestBytes })
    },
  }
}
