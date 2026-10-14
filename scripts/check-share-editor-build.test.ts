import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
// @ts-expect-error Build scripts are plain Node modules.
import { checkShareEditorBuild } from './check-share-editor-build.mjs'
function fixture(js: string, css = 'body{color:red}', modules = ['src/share-editor/main.ts']) {
  const dir = mkdtempSync(join(tmpdir(), 'share-kit-check-')); mkdirSync(join(dir, 'assets'))
  const asset = (text: string, ext: string) => {
    const sha256 = createHash('sha256').update(text).digest('hex'), name = `share-editor.${sha256}.${ext}`
    writeFileSync(join(dir, 'assets', name), text)
    return { name, sha256, sri: 'sha384-' + createHash('sha384').update(text).digest('base64') }
  }
  const manifest = { apiVersion: 1, js: asset(js, 'js'), css: asset(css, 'css') }
  writeFileSync(join(dir, 'share-editor-manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'share-editor-modules.json'), JSON.stringify({ jsSha256: manifest.js.sha256, modules }))
  return { dir, manifest, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}
const realApi = '(()=>{globalThis.NotemdShareEditor={apiVersion:1,mount(){}}})()'
describe('share kit artifact gate', () => {
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
  it.each([['import("https://cdn.invalid/x.js")', 'body{}', ['src/share-editor/main.ts']], [realApi, 'body{src:url(font.woff2)}', ['src/share-editor/main.ts']], [realApi, 'body{}', ['node_modules/@tauri-apps/api/core.js']], [realApi, 'body{}', ['node_modules/mermaid/dist/mermaid.js']]])('rejects nonclosed artifacts %#', async (js, css, modules) => {
    const f = fixture(js as string, css as string, modules as string[])
    try { await expect(checkShareEditorBuild(f.dir, join(f.dir, 'share-editor-modules.json'))).rejects.toThrow() } finally { f.dispose() }
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
