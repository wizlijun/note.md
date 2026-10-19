// @ts-expect-error Build scripts are plain Node modules.
import { peleNotice } from './pele-notice.mjs'
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
// @ts-expect-error Build scripts are plain Node modules.
import { checkShareEditorBuild } from './check-share-editor-build.mjs'
// @ts-expect-error Build scripts are plain Node modules.
import { shareMermaidBrowser } from './share-mermaid-browser.mjs'
function fixture(js: string, css = 'body{color:red}', modules = ['src/share-editor/main.ts']) {
  const dir = mkdtempSync(join(tmpdir(), 'share-kit-check-')); mkdirSync(join(dir, 'assets'))
  const asset = (text: string, ext: string, prefix = 'share-editor') => {
    const sha256 = createHash('sha256').update(text).digest('hex'), name = `${prefix}.${sha256}.${ext}`
    writeFileSync(join(dir, 'assets', name), text)
    return { name, sha256, sri: 'sha384-' + createHash('sha384').update(text).digest('base64') }
  }
  const manifest = { apiVersion: 1, js: asset(js, 'js'), css: asset(css, 'css') }
  writeFileSync(join(dir, 'share-editor-manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'share-editor-modules.json'), JSON.stringify({ jsSha256: manifest.js.sha256, modules }))
  return { dir, manifest, asset, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}
const realApi = '(()=>{globalThis.NotemdShareEditor={apiVersion:1,mount(){}}})()'
describe('share kit artifact gate', () => {
  it('rejects drift in the exact approved browser-global source', () => {
    const plugin = shareMermaidBrowser([])
    expect(() => plugin.transform('var root = Function("return this")();', '/node_modules/lodash-es/_root.js')).toThrow('source changed')
    expect(() => plugin.buildEnd()).toThrow('Missing approved')
  })
  it('never rewrites dynamic code in unknown modules', () => {
    expect(shareMermaidBrowser([]).transform('Function("return this")()', '/unknown.js')).toBeNull()
  })
  it('evaluates the registration instead of trusting an API-looking string', async () => {
    const f = fixture('(()=>{const text="NotemdShareEditor apiVersion mount"})()')
    try { await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow(/API/) } finally { f.dispose() }
  })
  it('rejects a stale module graph from another main IIFE', async () => {
    const f = fixture(realApi)
    writeFileSync(join(f.dir, 'share-editor-modules.json'), JSON.stringify({ jsSha256: 'f'.repeat(64), modules: ['src/share-editor/main.ts'] }))
    try { await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow(/graph hash mismatch/) } finally { f.dispose() }
  })
  it('rejects altered final bytes', async () => {
    const f = fixture(realApi); writeFileSync(join(f.dir, 'assets', f.manifest.js.name), realApi + ';')
    try { await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow(/hash/) } finally { f.dispose() }
  })
  it.each([['import("https://cdn.invalid/x.js")', 'body{}', ['src/share-editor/main.ts']], [realApi, 'body{src:url(font.woff2)}', ['src/share-editor/main.ts']]])('rejects nonclosed artifacts %#', async (js, css, modules) => {
    const f = fixture(js as string, css as string, modules as string[])
    try { await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow() } finally { f.dispose() }
  })
  it.each(['node_modules/@tauri-apps/api/core.js', 'node_modules/mermaid/dist/mermaid.js', 'node_modules/mermaid-mini/dist/index.js', 'node_modules/@moraya/core/dist/plugins/mermaid-renderer.js'])('rejects forbidden main dependency %s independently', async dependency => {
    const f = fixture(realApi, 'body{}', ['src/share-editor/main.ts', dependency])
    try { await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow('Forbidden Tauri or Mermaid main dependency') } finally { f.dispose() }
  })
  it('binds optional Mermaid actual source and input graphs to its distinct resource', async () => {
    const f = fixture(realApi), mermaid = f.asset('(()=>{globalThis.NotemdShareMermaid={render(){}}})()', 'js', 'share-editor-mermaid')
    const manifest = { ...f.manifest, mermaid }
    writeFileSync(join(f.dir, 'share-editor-manifest.json'), JSON.stringify(manifest))
    const graph = { jsSha256: manifest.js.sha256, modules: ['src/share-editor/main.ts'], mermaid: { jsSha256: mermaid.sha256, modules: ['src/share-editor/mermaid.ts', 'node_modules/mermaid/dist/index.js'], inputs: ['node_modules/mermaid-mini/dist/index.js'] } }
    try {
      writeFileSync(join(f.dir, 'share-editor-modules.json'), JSON.stringify(graph))
      await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).resolves.toMatchObject({ resources: { mermaid: { sha256: mermaid.sha256 } } })
      graph.mermaid.modules.push('node_modules/pele/dist/index.js')
      writeFileSync(join(f.dir, 'share-editor-modules.json'), JSON.stringify(graph))
      await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow('Opposite diagram engine dependency')
      graph.mermaid.modules.pop()
      graph.mermaid.jsSha256 = 'f'.repeat(64)
      writeFileSync(join(f.dir, 'share-editor-modules.json'), JSON.stringify(graph))
      await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow('Mermaid graph hash mismatch')
      graph.mermaid.jsSha256 = mermaid.sha256; graph.mermaid.inputs = []
      writeFileSync(join(f.dir, 'share-editor-modules.json'), JSON.stringify(graph))
      await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow('Missing actual Mermaid module')
      graph.mermaid.inputs = ['node_modules/mermaid-mini/dist/index.js']; graph.mermaid.modules = ['src/share-editor/mermaid.ts']
      writeFileSync(join(f.dir, 'share-editor-modules.json'), JSON.stringify(graph))
      await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow('Missing actual Mermaid module')
    } finally { f.dispose() }
  })
  it('enforces default gzip and per-resource byte budgets', async () => {
    for (const source of [realApi + ';const noise=' + JSON.stringify(randomBytes(1024 * 1024).toString('base64')), realApi + ';/*' + 'x'.repeat(8 * 1024 * 1024) + '*/']) {
      const f = fixture(source)
      try { await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow(/900KiB|8MiB/) } finally { f.dispose() }
    }
  })
  it('accepts a self-contained IIFE registration and inline CSS resources', async () => {
    const f = fixture(realApi, 'body{src:url(data:font/woff2;base64,YQ==)}')
    try { expect(await checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).toMatchObject({ apiVersion: 1, mount: 'function' }) } finally { f.dispose() }
  })
})

it.each(['pele', 'missing-notice', 'invalid', 'opposite', 'missing-input', 'missing-engine', 'empty-engine', 'null-engine'])('checks Pele graph evidence: %s', async variant => {
  const f = fixture(realApi), mermaid = f.asset((['missing-notice', 'empty-engine'].includes(variant) ? '' : `/*!\n${peleNotice}\n*/\n`) + '(()=>{globalThis.NotemdShareMermaid={supportsResponsiveLayout:true,render(){}}})()', 'js', 'share-editor-mermaid')
  const manifest = { ...f.manifest, mermaid }
  writeFileSync(join(f.dir, 'share-editor-manifest.json'), JSON.stringify(manifest))
  const graph = { jsSha256: manifest.js.sha256, modules: ['src/share-editor/main.ts'], mermaid: { engine: variant === 'missing-engine' ? undefined : variant === 'empty-engine' ? '' : variant === 'null-engine' ? null : variant === 'invalid' ? 'typo' : 'pele', jsSha256: mermaid.sha256, modules: ['src/share-editor/pele.ts', 'node_modules/pele/dist/index.js'], inputs: variant === 'missing-input' ? [] : ['src/share-editor/pele.ts', 'node_modules/pele/dist/index.js'] } }
  if (variant === 'opposite') graph.mermaid.inputs.push('node_modules/mermaid-mini/dist/index.js')
  writeFileSync(join(f.dir, 'share-editor-modules.json'), JSON.stringify(graph))
  try {
    const result = checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))
    if (variant === 'empty-engine' || variant === 'null-engine') await expect(result).rejects.toThrow('Invalid diagram engine metadata')
    else if (variant === 'missing-engine') await expect(result).rejects.toThrow('Missing actual Mermaid module')
    else if (variant === 'pele') await expect(result).resolves.toMatchObject({ resources: { mermaid: { sha256: mermaid.sha256 } } })
    else await expect(result).rejects.toThrow(/VITE_DIAGRAM_RENDERER|Invalid diagram engine metadata|Opposite|Missing actual Pele|Missing complete Pele/)
  } finally { f.dispose() }
})
it('rejects Pele in the main share IIFE', async () => {
  const f = fixture(realApi, 'body{}', ['src/share-editor/main.ts', 'node_modules/pele/dist/index.js'])
  try { await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow('Forbidden') } finally { f.dispose() }
})
