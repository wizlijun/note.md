import { peleNoticeBanner, peleNoticeGuard } from './pele-notice.mjs'
import { build } from 'vite'
import { diagramRendererOption } from './diagram-renderer-option.mjs'
import { shareMermaidBrowser } from './share-mermaid-browser.mjs'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const engine = diagramRendererOption(process.env.VITE_DIAGRAM_RENDERER)

// A separate single-entry build: app/Kit entries cannot share an IIFE output.
const emptyEnv = process.argv[3] ? resolve(process.argv[3]) : await mkdtemp(join(tmpdir(), 'notemd-share-empty-env-'))
const outDir = resolve(process.argv[2] ?? 'dist')
const graphPath = resolve(process.argv[4] ?? 'dist-share-editor/share-editor-modules.json')
try {
  let modules = []
  const result = await build({ configFile: false, envDir: emptyEnv, plugins: [svelte(), {
    name: 'share-editor-module-graph', generateBundle(_options, bundle) {
      modules = Object.values(bundle).filter(item => item.type === 'chunk').flatMap(chunk => Object.keys(chunk.modules)).sort()
    },
  }], build: {
    write: false, target: 'safari15', minify: 'esbuild', sourcemap: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false, rollupOptions: { input: 'src/share-editor/main.ts', preserveEntrySignatures: false,
      output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'share-editor.js', assetFileNames: '[name][extname]' } },
  } })
  const output = (Array.isArray(result) ? result[0] : result).output
  if (output.filter(item => item.type === 'chunk').length !== 1 || output.filter(item => item.type === 'asset').length !== 1) throw new Error('Expected one IIFE and one CSS resource')
  const manifest = { apiVersion: 1 }
  await mkdir(join(outDir, 'assets'), { recursive: true })
  for (const item of output) {
    const extension = item.type === 'chunk' ? 'js' : 'css'
    if (extension === 'css' && !item.fileName.endsWith('.css')) throw new Error('Unexpected external resource')
    const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const name = `share-editor.${sha256}.${extension}`
    manifest[extension] = { name, sha256, sri: 'sha384-' + createHash('sha384').update(bytes).digest('base64') }
    await writeFile(join(outDir, 'assets', name), bytes)
  }
  let mermaidModules = [], mermaidInputs = [], browserGlobals = []
  const mermaidResult = await build({ configFile: false, envDir: emptyEnv, plugins: [peleNoticeGuard(), ...(engine === 'mermaid' ? [shareMermaidBrowser(browserGlobals)] : []), { name: 'share-mermaid-module-graph', generateBundle(_options, bundle) {
    mermaidInputs = [...this.getModuleIds()].sort()
    mermaidModules = Object.values(bundle).filter(item => item.type === 'chunk').flatMap(chunk => Object.keys(chunk.modules)).sort()
  } }], build: { write: false, target: 'safari15', minify: 'esbuild', sourcemap: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    rollupOptions: { input: `src/share-editor/${engine}.ts`, preserveEntrySignatures: false, output: { banner: peleNoticeBanner, format: 'iife', inlineDynamicImports: true } } } })
  const mermaidOutput = (Array.isArray(mermaidResult) ? mermaidResult[0] : mermaidResult).output
  if (mermaidOutput.length !== 1 || mermaidOutput[0].type !== 'chunk') throw Error('Expected one independent Mermaid IIFE')
  const mermaidBytes = Buffer.from(mermaidOutput[0].code), mermaidHash = createHash('sha256').update(mermaidBytes).digest('hex')
  manifest.mermaid = { name: `share-editor-mermaid.${mermaidHash}.js`, sha256: mermaidHash, sri: 'sha384-' + createHash('sha384').update(mermaidBytes).digest('base64') }
  await writeFile(join(outDir, 'assets', manifest.mermaid.name), mermaidBytes)
  await writeFile(join(outDir, 'share-editor-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await mkdir(dirname(graphPath), { recursive: true })
  await writeFile(graphPath, JSON.stringify({ jsSha256: manifest.js.sha256, modules, mermaid: { engine, jsSha256: manifest.mermaid.sha256, modules: mermaidModules, inputs: mermaidInputs, browserGlobals } }, null, 2) + '\n')
  console.log(JSON.stringify(manifest, null, 2))
} finally { if (!process.argv[3]) await rm(emptyEnv, { recursive: true, force: true }) }
