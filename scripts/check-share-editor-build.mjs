import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { Window } from 'happy-dom'
const require = createRequire(import.meta.url)
const viteRequire = createRequire(require.resolve('vite/package.json'))
const { parseAst } = await import(pathToFileURL(viteRequire.resolve('rollup/parseAst')).href)
function assert(condition, message) { if (!condition) throw new Error(message) }
function walk(node) {
  if (!node || typeof node !== 'object') return
  assert(!['ImportExpression', 'ImportDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration'].includes(node.type), 'Kit must be one closed classic IIFE; no imports/exports')
  if (node.type === 'CallExpression' || node.type === 'NewExpression') assert(node.callee?.name !== 'eval' && node.callee?.name !== 'Function', 'Kit requires unsafe-eval')
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value)
}
export async function checkShareEditorBuild(directory, graphPath = resolve('dist-share-editor/share-editor-modules.json')) {
  const manifest = JSON.parse(readFileSync(join(directory, 'share-editor-manifest.json'), 'utf8'))
  assert(manifest.apiVersion === 1 && Object.keys(manifest).every(key => ['apiVersion', 'js', 'css', 'mermaid'].includes(key)), 'Invalid manifest version or fields')
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  assert(graph.jsSha256 === manifest.js?.sha256, 'Module graph hash mismatch')
  const modules = graph.modules
  assert(Array.isArray(modules), 'Invalid module graph')
  assert(modules.length && modules.some(id => id.endsWith('src/share-editor/main.ts')), 'Missing actual main module')
  assert(modules.every(id => !/@tauri-apps|mermaid-renderer|node_modules\/(?:\.pnpm\/)?mermaid(?:[-/@])/.test(id)), 'Forbidden Tauri or Mermaid main dependency')
  if (manifest.mermaid) {
    assert(graph.mermaid?.jsSha256 === manifest.mermaid.sha256, 'Mermaid graph hash mismatch')
    assert(Array.isArray(graph.mermaid.modules) && graph.mermaid.modules.some(id => id.endsWith('src/share-editor/mermaid.ts')) && graph.mermaid.modules.some(id => /node_modules\/mermaid\//.test(id)) && Array.isArray(graph.mermaid.inputs) && graph.mermaid.inputs.some(id => /node_modules\/mermaid-mini\//.test(id)), 'Missing actual Mermaid module')
    assert(graph.mermaid.modules.every(id => !/@tauri-apps|src\/share-editor\/main.ts/.test(id)), 'Forbidden Mermaid dependency')
  }
  const resources = {}
  for (const [kind, asset] of Object.entries(manifest).filter(([key]) => key !== 'apiVersion')) {
    const ext = kind === 'css' ? 'css' : 'js'
    assert(new RegExp(`^share-editor${kind === 'mermaid' ? '-mermaid' : ''}\\.[a-f0-9]{64}\\.${ext}$`).test(asset.name), 'Invalid asset name')
    const bytes = readFileSync(join(directory, 'assets', asset.name))
    assert(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, 'Kit resource exceeds 8MiB or is empty')
    const hash = createHash('sha256').update(bytes).digest('hex')
    assert(hash === asset.sha256 && asset.name.includes(`.${hash}.`), 'Kit hash mismatch')
    assert(asset.sri === 'sha384-' + createHash('sha384').update(bytes).digest('base64'), 'Kit SRI mismatch')
    const source = bytes.toString('utf8')
    if (ext === 'js') walk(parseAst(source))
    else {
      assert(!/@import\b/i.test(source), 'External CSS import')
      for (const [, url] of source.matchAll(/url\(\s*["']?([^)'"\s]+)/g)) assert(url.startsWith('data:') || url.startsWith('#'), 'External CSS resource')
    }
    resources[kind] = { bytes: bytes.length, gzip: gzipSync(bytes).length, sha256: hash, sri: asset.sri }
  }
  assert(resources.js && resources.css, 'Missing main JS/CSS')
  assert(resources.js.gzip <= 900 * 1024, 'Main kit gzip exceeds 900KiB')
  const window = new Window({ url: 'https://share.test/' })
  try {
    window.structuredClone = structuredClone
    window.eval(readFileSync(join(directory, 'assets', manifest.js.name), 'utf8'))
    assert(window.NotemdShareEditor?.apiVersion === 1 && typeof window.NotemdShareEditor?.mount === 'function', 'Kit API registration missing')
    if (manifest.mermaid) {
      window.eval(readFileSync(join(directory, 'assets', manifest.mermaid.name), 'utf8'))
      assert(typeof window.NotemdShareMermaid?.render === 'function', 'Mermaid API registration missing')
    }
    return { apiVersion: window.NotemdShareEditor.apiVersion, mount: typeof window.NotemdShareEditor.mount, resources, modules: modules.length }
  } finally { await window.happyDOM.close() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await checkShareEditorBuild(resolve(process.argv[2] ?? 'dist'), process.argv[3] ? resolve(process.argv[3]) : undefined), null, 2))
