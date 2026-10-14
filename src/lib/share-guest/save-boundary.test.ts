// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocked = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocked.invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({ get: async () => ({ token: 'synthetic' }) }) } }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: (p: string) => readFile(p, 'utf8'), writeTextFile: (p: string, s: string) => writeFile(p, s), stat: (p: string) => stat(p) }))
vi.mock('../settings.svelte', () => ({ settings: {}, pushRecentFile: async () => {}, getRecentMode: () => null, setRecentMode: async () => {} }))
vi.mock('../plugins/custom-editors', () => ({ customEditorFor: () => null }))
vi.mock('../plugins/runtime.svelte', () => ({ pluginRuntime: { manifests: [] } }))
vi.mock('../file-watcher.svelte', () => ({ startWatchingTab: async () => {}, stopWatchingTab: async () => {}, rebindTabPath: async () => {} }))
vi.mock('../file-editor-sessions', () => ({ fileEditorSession: () => undefined, captureFileSave: () => undefined, acknowledgeFileSave: () => {}, closeFileEditorSession: () => {} }))
vi.mock('../mdblock/auto-refresh', () => ({ maybeAutoRefresh: async () => {} }))
vi.mock('../platform.svelte', () => ({ platform: async () => 'macos' }))
vi.mock('../sotvault.svelte', () => ({ sourceForVaultPath: () => null, maybeCheckVaultUpdate: async () => {}, pushSourceToVaultIfTracked: async () => {} }))
vi.mock('../outline/migrate', () => ({ migrateLegacyCompanion: async () => {} }))
vi.mock('../insights/tracker.svelte', () => ({ onActiveDocChanged: () => {} }))
import { openFile, tabs, isReadOnlyTab } from '../tabs.svelte'
import { buildDesktopSubmission } from './host'
import { sha256Sync } from '../share-merge/hash'

it('submission must preserve an opened image attachment through real openFile/saveTab/writeMd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guest-review-'))
  const imagePath = join(root, 'image.png'), notePath = join(root, 'a.md')
  const originalImage = Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3])
  const base = 'base\n'
  const info = { root, project_id: 'pid', snapshotId: 'sid', files: [{ path: 'a.md', hash: sha256Sync(base) },{path:'image.png',hash:'synthetic-image'}], outbox: [], submitted: [] }
  mocked.invoke.mockImplementation(async (_: string, { request }: any) => {
    if (request.op === 'inspect') return info
    if (request.op === 'read-work') return { info, base: { 'a.md': { markdown: base, hash: sha256Sync(base) } }, after: { 'a.md': await readFile(notePath, 'utf8') }, added: [], missing: [] }
    throw Error('unexpected IPC')
  })
  try {
    await writeFile(imagePath, originalImage); await writeFile(notePath, base)
    await openFile(imagePath); await openFile(notePath)
    const imageTab = tabs.find(t => t.filePath === imagePath)!
    expect(imageTab.kind).toBe('image'); expect(imageTab.currentContent).toBe(''); expect(isReadOnlyTab(imageTab)).toBe(false)
    const note=tabs.find(t=>t.filePath===notePath)!;note.currentContent='saved Markdown edit\n'
    const built=await buildDesktopSubmission(root, note.id, '', '')
    expect(JSON.parse(built.body).edits[0].afterMarkdown).toBe('saved Markdown edit\n')
    const actual = await readFile(imagePath)
    console.log(JSON.stringify({ beforeBytes: originalImage.length, afterBytes: actual.length }))
    expect(actual).toEqual(originalImage)
    const {createHash}=await import('node:crypto')
    expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(originalImage).digest('hex'))
  } finally { tabs.length = 0; await rm(root, { recursive: true, force: true }) }
})

it('saves every approved Markdown extension, preserves readonly/unlisted documents, and matches the real browser builder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guest-save-'))
  const paths = ['a.markdown', 'b.mdown', 'c.mkd', 'd.mdx', 'A.MD']
  const base = Object.fromEntries(paths.map(path => [path, { markdown: '# '+path+'\n', hash: sha256Sync('# '+path+'\n') }]))
  const after = Object.fromEntries(paths.map(path => [path, base[path].markdown+'saved edit\n']))
  const readonly = '---\nreadonly: true\n---\nlocked\n'
  const info = { root, project_id: 'pid', snapshotId: 'sid', files: [...paths.map(path => ({path,hash:base[path].hash})),{path:'locked.md',hash:sha256Sync(readonly)}], outbox: [], submitted: [] }
  let browser: Awaited<ReturnType<typeof import('../../share-editor/main').shareEditor.mount>> | undefined
  try {
    for (const path of paths) { await writeFile(join(root,path),base[path].markdown); await openFile(join(root,path)); tabs.find(t=>t.filePath===join(root,path))!.currentContent=after[path] }
    await writeFile(join(root,'locked.md'),readonly); await openFile(join(root,'locked.md')); tabs.find(t=>t.filePath===join(root,'locked.md'))!.currentContent='readonly unsaved edit'
    await writeFile(join(root,'unlisted.md'),'unlisted disk'); await openFile(join(root,'unlisted.md')); tabs.find(t=>t.filePath===join(root,'unlisted.md'))!.currentContent='unlisted unsaved'
    mocked.invoke.mockImplementation(async (_: string, {request}: any) => {
      if(request.op==='inspect') return info
      if(request.op==='read-work') return {info,base,after:Object.fromEntries(await Promise.all(paths.map(async path=>[path,await readFile(join(root,path),'utf8')]))),added:['unlisted.md'],missing:[]}
      throw Error('unexpected IPC')
    })
    const built=await buildDesktopSubmission(root,tabs.find(t=>t.filePath===join(root,paths[0]))!.id,'all extensions','Visitor')
    expect(JSON.parse(built.body).edits.map((e:any)=>e.path).sort()).toEqual([...paths].sort())
    for(const path of paths) expect(await readFile(join(root,path),'utf8')).toBe(after[path])
    expect(await readFile(join(root,'locked.md'),'utf8')).toBe(readonly)
    expect(await readFile(join(root,'unlisted.md'),'utf8')).toBe('unlisted disk')
    const {shareEditor}=await import('../../share-editor/main')
    const target=document.createElement('div');document.body.append(target)
    browser=await shareEditor.mount(target,{apiVersion:1,theme:{themeId:'default'},snapshot:{project_id:'pid',snapshotId:'sid',entry:paths[0],files:paths.map(path=>({path,...base[path]}))},loadDraft:async()=>({v:2,lineageId:'L',snapshotId:'sid',base,after,annotationKinds:{}}),saveDraft:async d=>structuredClone(d),submit:vi.fn(),notify:vi.fn(),openFile:vi.fn(),setFileBadges:vi.fn()},{path:paths[0]})
    const fromBrowser=await browser.buildSubmission({message:'all extensions',name:'Visitor'})
    const normalize=(body:string)=>{const {submissionId,client,...rest}=JSON.parse(body);return rest}
    expect(normalize(built.body)).toEqual(normalize(fromBrowser.body))
  } finally { if(browser) await browser.destroy(); tabs.length=0; document.body.replaceChildren(); await rm(root,{recursive:true,force:true}) }
})
