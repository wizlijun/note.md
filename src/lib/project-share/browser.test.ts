// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Marked } from 'marked'
import { Zip, ZipPassThrough, Unzip, UnzipPassThrough, unzipSync } from 'fflate'
import { buildProjectBundle } from './bundle'
import { projectShareBrowser } from './browser'
import { anchor } from '../share-merge/anchor'
import type { ProjectSnapshot } from './types'

const snapshot: ProjectSnapshot = { schemaVersion: 1, project_id: 'project_1', snapshotId: 'snapshot_1', entry: 'README.md', files: [
  { path: 'README.md', hash: 'a'.repeat(64), bytes: 20, markdown: '# 方案\n\n[调研](docs/research.md#调查)\n\n[[ Research |说明 ]]\n\n原始内容\n\n<script>window.pwned=true</script>' },
  { path: 'docs/research.md', hash: 'b'.repeat(64), bytes: 10, markdown: '# 调查\n\n[返回](../README.md)' },
  { path: 'Research.md', hash: 'c'.repeat(64), bytes: 5, markdown: '# Research' },
] }
let values: Map<string, any>
function fakeDatabase(delay = 0, fail = false, failWrites = false) {
  vi.stubGlobal('indexedDB', { open: () => {
    const op: any = { result: { transaction: () => {
      const tx: any = { objectStore: () => ({
        getAllKeys: () => { const result={result:[...values.keys()]}; setTimeout(()=>tx.oncomplete?.(),0);return result },
        delete: (key:string) => {values.delete(key);setTimeout(()=>tx.oncomplete?.(),0);return {}},
        get: (key: string) => { const result = { result: structuredClone(values.get(key)) }; setTimeout(() => tx.oncomplete?.(), 0); return result },
        put: (value: any, key: string) => { if(failWrites) { tx.error=new Error('disk full'); setTimeout(()=>tx.onerror?.(),0) } else { values.set(key, structuredClone(value)); setTimeout(() => tx.oncomplete?.(), 0) } return {} },
      }) }
      return tx
    } } }
    setTimeout(() => { if(fail) { op.error = new Error('storage unavailable'); op.onerror?.() } else op.onsuccess?.() }, delay)
    return op
  } })
}
const $ = (id: string) => document.getElementById(id)!
const status = () => $('status').textContent!
const input = (value: string) => { ($('editor') as HTMLTextAreaElement).value = value; $('editor').dispatchEvent(new Event('input')) }
const click = (id: string) => $(''+id).click()

function pendingPublication() {
  const data=JSON.parse($('project-data').textContent!)
  data.archiveUrl='https://share.test/project/slug/download'
  data.publicationPending=true
  $('project-data').textContent=JSON.stringify(data)
  return data
}

function publicationPoll() {
  let check: (()=>Promise<void>) | undefined
  const original=globalThis.setTimeout.bind(globalThis)
  const timer=vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:any,delay?:number,...args:any[])=> {
    if(delay===3000) { check=callback; return 0 as any }
    return original(callback,delay,...args)
  }) as typeof setTimeout)
  return {run:async()=> { expect(check).toBeDefined(); await check!() },restore:()=>timer.mockRestore()}
}

beforeEach(() => {
  values = new Map()
  vi.unstubAllGlobals()
  history.replaceState(null, '', '/#feedback=visitor-token')
  const html = buildProjectBundle(snapshot, 'https://share.test/feedback/project_1')
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  // Existing published pages lack versionUrl; retain their quiet compatibility path.
  const data=JSON.parse($('project-data').textContent!);delete data.versionUrl;$('project-data').textContent=JSON.stringify(data)
  fakeDatabase()
})

describe('browser project collaboration', () => {
  it('uses an edge icon with no top toolbar and updates the mobile backdrop on resize', async () => {
    await projectShareBrowser(new Marked())
    expect(document.querySelector('.reader-tools')).toBeNull()
    expect($('file-toggle').querySelector('svg')).not.toBeNull()
    expect($('file-toggle').getAttribute('aria-label')).toBe('展开文件导航')
    click('file-toggle')
    expect(document.querySelector('.layout')?.classList.contains('files-open')).toBe(true)
    expect($('file-toggle').getAttribute('aria-label')).toBe('收起文件导航')
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    window.dispatchEvent(new Event('resize'))
    expect($('file-backdrop').hidden).toBe(false)
    click('file-toggle')
    expect($('file-backdrop').hidden).toBe(true)
  })

  it('downloads the published snapshot as a ZIP with Unicode directories and binary attachments in read-only mode', async () => {
    history.replaceState(null, '', '/')
    const data=JSON.parse($('project-data').textContent!)
    data.title='分享/标题'
    data.snapshot.files.push({path:'附件/图片.png',dataUrl:'data:image/png;base64,AAH+/w==',bytes:4,hash:'d'.repeat(64)})
    data.snapshot.files.push({path:'__proto__',dataUrl:'data:application/octet-stream;base64,AA==',bytes:1,hash:'f'.repeat(64)})
    data.snapshot.files.push({path:'中文/空白.md',markdown:'',bytes:0,hash:'e'.repeat(64)})
    $('project-data').textContent=JSON.stringify(data)
    let blob: Blob | undefined
    vi.spyOn(URL,'createObjectURL').mockImplementation(value=> {blob=value as Blob; return 'blob:test'})
    const save=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    await projectShareBrowser(new Marked(), {Zip,ZipPassThrough})
    click('download-all')
    expect((save.mock.instances[0] as HTMLAnchorElement).download).toBe('分享_标题.zip')
    const archive=unzipSync(new Uint8Array(await blob!.arrayBuffer()))
    expect(Object.keys(archive).sort()).toEqual(data.snapshot.files.map((file:any)=>file.path).filter((path:string)=>path!=='__proto__').sort())
    expect(new TextDecoder().decode(archive['README.md'])).toBe(snapshot.files[0].markdown)
    expect(Array.from(archive['附件/图片.png'])).toEqual([0,1,254,255])
    expect(archive['中文/空白.md'].length).toBe(0)
    const paths:string[]=[]
    const reader=new Unzip(file=> { paths.push(file.name); file.ondata=()=>{}; file.start() })
    reader.register(UnzipPassThrough); reader.push(new Uint8Array(await blob!.arrayBuffer()),true)
    expect(paths).toContain('__proto__')
    expect($('collaboration').hidden).toBe(true)
    save.mockRestore()
  })

  it('downloads the right-clicked published file without changing selection or including local drafts', async () => {
    let blob: Blob | undefined
    vi.spyOn(URL,'createObjectURL').mockImplementation(value=> {blob=value as Blob; return 'blob:test'})
    const save=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    await projectShareBrowser(new Marked(),{Zip,ZipPassThrough})
    click('edit'); input('本地草稿')
    const row=document.querySelector('[data-file="Research.md"]') as HTMLElement
    row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:35,clientY:50}))
    expect($('file-menu').hidden).toBe(false)
    expect($('editor').getAttribute('hidden')).toBeNull()
    click('download-file')
    expect((save.mock.instances[0] as HTMLAnchorElement).download).toBe('Research.md')
    expect(await blob!.text()).toBe('# Research')
    expect($('file-menu').hidden).toBe(true)
    row.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'F10',shiftKey:true}))
    expect($('file-menu').hidden).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}))
    expect($('file-menu').hidden).toBe(true)
    expect(document.activeElement).toBe(row)
    expect(($('editor') as HTMLTextAreaElement).value).toBe('本地草稿')
    save.mockRestore()
  })

  it('runs the exact serialized bundle including its embedded ZIP dependency', async () => {
    let blob:Blob|undefined
    vi.spyOn(URL,'createObjectURL').mockImplementation(value=> {blob=value as Blob; return 'blob:test'})
    const save=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    const scripts=Array.from(document.querySelectorAll('script'))
    new Function(scripts[scripts.length-1].textContent!)()
    await vi.waitFor(()=>expect(($('edit') as HTMLButtonElement).disabled).toBe(false))
    click('download-all')
    expect(new TextDecoder().decode(unzipSync(new Uint8Array(await blob!.arrayBuffer()))['README.md'])).toBe(snapshot.files[0].markdown)
    save.mockRestore()
  })

  it('downloads a retained archive directly instead of rebuilding a ZIP in the browser', async () => {
    const data=JSON.parse($('project-data').textContent!)
    data.archiveUrl='https://share.test/project/slug/download'
    $('project-data').textContent=JSON.stringify(data)
    const save=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    await projectShareBrowser(new Marked())
    click('download-all')
    expect((save.mock.instances[0] as HTMLAnchorElement).href).toBe(data.archiveUrl)
    save.mockRestore()
  })

  it('disables pending archive downloads and explains syncing before local storage recovery completes', async () => {
    pendingPublication()
    fakeDatabase(25)
    const poll=publicationPoll()
    const loading=projectShareBrowser(new Marked())
    try {
      expect(($('download-all') as HTMLButtonElement).disabled).toBe(true)
      expect($('download-all').textContent).toContain('同步中')
      expect(status()).toContain('其余分享文件正在同步')
    } finally { await loading; poll.restore() }
  })

  it('polls pending archives with HEAD and reloads a clean page only after the archive is ready', async () => {
    const data=pendingPublication()
    const poll=publicationPoll()
    const reload=vi.spyOn(location,'reload').mockImplementation(()=>{})
    const fetchArchive=vi.fn().mockResolvedValueOnce(new Response(null,{status:409})).mockResolvedValueOnce(new Response(null,{status:200}))
    vi.stubGlobal('fetch',fetchArchive)
    try {
      await projectShareBrowser(new Marked())
      expect(($('download-all') as HTMLButtonElement).disabled).toBe(true)
      await poll.run()
      expect(reload).not.toHaveBeenCalled()
      expect(($('download-all') as HTMLButtonElement).disabled).toBe(true)
      await poll.run()
      expect(fetchArchive.mock.calls).toEqual([[data.archiveUrl,{method:'HEAD',cache:'no-store'}],[data.archiveUrl,{method:'HEAD',cache:'no-store'}]])
      expect(reload).toHaveBeenCalledTimes(1)
      expect(($('download-all') as HTMLButtonElement).disabled).toBe(false)
    } finally { poll.restore(); reload.mockRestore() }
  })

  it('keeps entry drafts when a pending archive becomes ready and downloads the retained URL directly', async () => {
    const data=pendingPublication()
    values.set('project_1:snapshot_1',{drafts:{'README.md':'入口草稿'},annotations:[],pending:null})
    const poll=publicationPoll()
    const reload=vi.spyOn(location,'reload').mockImplementation(()=>{})
    const save=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    const fetchArchive=vi.fn().mockResolvedValue(new Response(null,{status:200}))
    vi.stubGlobal('fetch',fetchArchive)
    try {
      await projectShareBrowser(new Marked())
      await poll.run()
      expect(reload).not.toHaveBeenCalled()
      expect(status()).toContain('请先导出当前入口草稿备份')
      expect(($('editor') as HTMLTextAreaElement).value).toBe('入口草稿')
      click('download-all')
      expect(save).toHaveBeenCalledTimes(1)
      expect((save.mock.instances[0] as HTMLAnchorElement).href).toBe(data.archiveUrl)
      expect(fetchArchive).toHaveBeenCalledTimes(1)
    } finally { poll.restore(); reload.mockRestore(); save.mockRestore() }
  })

  it('starts secondary collaboration controls collapsed and reveals them on demand', async () => {
    await projectShareBrowser(new Marked())
    const details = $('collaboration-options') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(details.contains($('name')) && details.contains($('baseline')) && details.contains($('export'))).toBe(true)
    details.open = true
    expect(details.open).toBe(true)
    expect(($('baseline') as HTMLButtonElement).disabled).toBe(false)
  })
  it('restores a visible focus target after selecting files in desktop and mobile editing', async () => {
    await projectShareBrowser(new Marked())
    click('file-toggle')
    const desktop = document.querySelector('[data-file="Research.md"]') as HTMLButtonElement
    desktop.focus(); desktop.click()
    expect(document.activeElement?.getAttribute('data-file')).toBe('Research.md')
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    click('edit')
    const next = document.querySelector('[data-file="README.md"]') as HTMLButtonElement
    next.focus(); next.click()
    expect($('file-panel').hidden).toBe(true)
    expect(document.activeElement).toBe($('editor'))
    expect($('editor').hidden).toBe(false)
  })

  it('starts collapsed and preserves frozen diagrams, math and approved resources', async () => {
    const data=JSON.parse($('project-data').textContent!)
    data.title='分享 <标题>'
    data.snapshot.files.push({path:'assets/pic.png',hash:'d'.repeat(64),bytes:4,dataUrl:'data:image/png;base64,AAAA'})
    data.presentation={themeId:'custom',documents:{'README.md':'<h1 id="original">冻结原文</h1><svg viewBox="0 0 20 20"><text>图表</text></svg><span class="katex"><math><mi>x</mi></math></span><img data-project-resource="assets/pic.png">'},warnings:[]}
    $('project-data').textContent=JSON.stringify(data)
    await projectShareBrowser(new Marked())
    expect($('file-panel').hidden).toBe(true)
    expect(document.querySelector('header')).toBeNull()
    expect(document.getElementById('title')).toBeNull()
    expect(document.title).toBe('分享 <标题> · 可编辑')
    expect($('document').getAttribute('data-theme')).toBe('custom')
    expect($('reader').getAttribute('data-theme')).toBe('custom')
    expect($('document').querySelector('svg text')?.textContent).toBe('图表')
    expect($('document').querySelector('.katex math mi')?.textContent).toBe('x')
    expect($('document').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    click('file-toggle')
    expect($('file-panel').hidden).toBe(false)
    expect(document.querySelector('[data-folder="docs"]')?.getAttribute('aria-expanded')).toBe('false')
    click('edit'); input('草稿'); click('edit')
    expect($('document').querySelector('svg')).toBeNull()
    click('baseline')
    expect($('document').querySelector('svg text')?.textContent).toBe('图表')
    expect(document.title).toBe('分享 <标题> · 可编辑')
  })
  it('sorts frozen source times and reveals only current ancestors', async () => {
    const data=JSON.parse($('project-data').textContent!)
    data.snapshot.entry='older/deep/entry.md'
    data.snapshot.files=[
      {path:'unknown.md',markdown:'# unknown'}, {path:'first.md',markdown:'# first',modifiedAt:30},
      {path:'tie.md',markdown:'# tie',modifiedAt:30}, {path:'last.md',markdown:'# last',modifiedAt:10},
      {path:'older/deep/entry.md',markdown:'# entry',modifiedAt:1},
      {path:'newer/child.md',markdown:'# child',modifiedAt:50},
    ]
    $('project-data').textContent=JSON.stringify(data)
    await projectShareBrowser(new Marked())
    click('file-toggle')
    expect(Array.from($('files').children).map(row=>row.querySelector('button')?.getAttribute('data-folder')??row.querySelector('button')?.getAttribute('data-file'))).toEqual(['newer','older','first.md','tie.md','last.md','unknown.md'])
    expect(document.querySelector('[data-folder="older"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-folder="older/deep"]')?.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-folder="newer"]')?.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[aria-current="page"]')?.getAttribute('data-file')).toBe('older/deep/entry.md')
  })
  it('uses cached capability for title and hides collaboration for read-only viewers', async () => {
    history.replaceState(null,'','/')
    await projectShareBrowser(new Marked())
    expect(document.title).toBe('README · 只读')
    expect($('collaboration').hidden).toBe(true)
    expect(($('edit') as HTMLButtonElement).disabled).toBe(true)
    expect(($('submit') as HTMLButtonElement).disabled).toBe(true)
    expect(status()).toBe('')
    values.set('project_1:token','cached-token')
    await projectShareBrowser(new Marked())
    expect(document.title).toBe('README · 可编辑')
    expect($('collaboration').hidden).toBe(false)
    expect(status()).toBe('')
  })
  it('keeps expansion on desktop navigation and freezes stable name ordering for same and unknown times', async () => {
    const data=JSON.parse($('project-data').textContent!)
    data.snapshot.files=[
      {path:'zeta/same.md',markdown:'# z',modifiedAt:20},
      {path:'alpha/same.md',markdown:'# a',modifiedAt:20},
      {path:'no-time/z.md',markdown:'# z'}, {path:'bad-time/a.md',markdown:'# a',modifiedAt:-1},
      {path:'README.md',markdown:'# entry'}, {path:'invalid.md',markdown:'# invalid',modifiedAt:1.5},
      {path:'assets/image.png',dataUrl:'data:image/png;base64,AAAA'},
    ]
    $('project-data').textContent=JSON.stringify(data)
    await projectShareBrowser(new Marked())
    click('file-toggle')
    expect(Array.from($('files').children).map(row=>row.querySelector('button')?.textContent)).toEqual(['alpha','zeta','bad-time','no-time','invalid.md','README.md'])
    document.querySelector<HTMLButtonElement>('[data-folder="alpha"]')!.click()
    expect(document.querySelector('[data-folder="alpha"]')!.getAttribute('aria-expanded')).toBe('true')
    document.querySelector<HTMLButtonElement>('[data-file="zeta/same.md"]')!.click()
    expect($('file-panel').hidden).toBe(false)
    expect(document.querySelector('[data-folder="alpha"]')!.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-folder="zeta"]')!.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[aria-current="page"]')!.getAttribute('data-file')).toBe('zeta/same.md')
  })
  it('binds frozen deep-document links from snapshot root and refuses missing resource markers', async () => {
    const data=JSON.parse($('project-data').textContent!)
    data.presentation={themeId:'custom',documents:{'README.md':'<h1 id="heading">正文</h1><a data-project-path="docs/research.md#调查">调查</a><img src="file:///private/secret" data-project-resource="missing.png">','docs/research.md':'<h1 id="调查">冻结调查</h1><a data-project-path="README.md#heading">返回</a>'}}
    $('project-data').textContent=JSON.stringify(data)
    await projectShareBrowser(new Marked())
    expect($('document').querySelector('img')!.hasAttribute('src')).toBe(false)
    expect($('document').querySelector('a')!.getAttribute('href')).toBe('#doc=docs%2Fresearch.md&heading=%E8%B0%83%E6%9F%A5')
    history.replaceState(null,'','/#doc=docs%2Fresearch.md&heading=%E8%B0%83%E6%9F%A5')
    window.dispatchEvent(new Event('hashchange'))
    expect($('document').querySelector('h1')!.textContent).toBe('冻结调查')
    expect($('document').querySelector('a')!.getAttribute('href')).toBe('#doc=README.md&heading=heading')
    expect(document.title).toBe('README · 可编辑')
  })
  it('sanitizes modified Markdown and creates unique fallback preview heading anchors', async () => {
    await projectShareBrowser(new Marked())
    click('edit'); input('# 同名\n\n# 同名\n\n<script>window.pwned=true</script><custom>保留文字</custom><img src="javascript:alert(1)" onerror="alert(1)">'); click('edit')
    expect(Array.from($('document').querySelectorAll('h1')).map(element=>element.id)).toEqual(['同名','同名-1'])
    expect($('document').querySelector('script')).toBeNull()
    expect($('document').querySelector('[onerror]')).toBeNull()
    expect($('document').textContent).toContain('保留文字')
    expect($('document').querySelector('img')!.hasAttribute('src')).toBe(false)
  })
  it('rejects outside selections and gives explicit draft diagram previews', async () => {
    await projectShareBrowser(new Marked())
    const prompt=vi.fn(()=>'评论'); vi.stubGlobal('prompt',prompt)
    const range=document.createRange(); range.selectNodeContents($('files'))
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    click('annotate')
    expect(prompt).not.toHaveBeenCalled()
    expect(status()).toContain('正文')
    click('edit'); input('# 草稿\n\n```mermaid\ngraph TD; A-->B\n```'); click('edit')
    expect($('document').textContent).toContain('合入并重新发布')
    expect($('document').querySelector('pre code')?.textContent).toContain('A-->B')
  })
  it('closes mobile drawer after navigation and restores toggle focus with Escape', async () => {
    vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true})))
    await projectShareBrowser(new Marked())
    click('file-toggle')
    document.querySelector<HTMLButtonElement>('[data-file="Research.md"]')!.click()
    await vi.waitFor(()=>expect($('file-panel').hidden).toBe(true))
    expect(document.activeElement).toBe($('document'))
    click('file-toggle')
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))
    expect($('file-panel').hidden).toBe(true)
    expect(document.activeElement).toBe($('file-toggle'))
  })
  it('waits for stored drafts before enabling edits and retains token across early navigation', async () => {
    values.set('project_1:snapshot_1', { drafts: { 'README.md': 'saved draft' }, annotations: [], pending: null })
    fakeDatabase(25)
    const loading = projectShareBrowser(new Marked())
    expect(($('edit') as HTMLButtonElement).disabled).toBe(true)
    expect(($('submit') as HTMLButtonElement).disabled).toBe(true)
    document.querySelector<HTMLButtonElement>('[data-file="Research.md"]')!.click()
    await loading
    expect(values.get('project_1:token')).toBe('visitor-token')
    expect(($('edit') as HTMLButtonElement).disabled).toBe(false)
    expect(document.title).toBe('README · 可编辑')
    document.querySelector<HTMLButtonElement>('[data-file="README.md"]')!.click()
    await vi.waitFor(() => expect(($('editor') as HTMLTextAreaElement).value).toBe('saved draft'))
    expect((window as any).pwned).toBeUndefined()
  })
  it('keeps private branch intent out of outgoing v1 feedback', async () => {
    const data=JSON.parse($('project-data').textContent!)
    data.snapshot.git={branch_intent:{head:'private-intent-head',results_hash:'private-results-hash',commit:'private-intent-commit',branch:'private-intent-branch'}}
    data.snapshot.parentSnapshotId='private-parent'
    data.snapshot.gitError='private-error'
    $('project-data').textContent=JSON.stringify(data)
    const send=vi.fn(async (_url:string,_init:RequestInit)=>Response.json({}))
    vi.stubGlobal('fetch',send)
    await projectShareBrowser(new Marked())
    click('edit'); input('public suggestion'); click('submit')
    await vi.waitFor(()=>expect(status()).toContain('已送达'))
    const body=send.mock.calls[0][1].body as string
    expect(JSON.parse(body)).toMatchObject({schemaVersion:2,edits:[{path:'README.md',afterMarkdown:'public suggestion'}]})
    for(const secret of ['branch_intent','private-intent-head','private-results-hash','private-intent-commit','private-intent-branch','parentSnapshotId','gitError','private-parent','private-error']) expect(body).not.toContain(secret)
  })
  it('allows an oversized candidate to be reduced and freezes only a sendable packet', async () => {
    const send = vi.fn(async (_url: string, _init: RequestInit) => Response.json({}))
    vi.stubGlobal('fetch', send)
    await projectShareBrowser(new Marked())
    click('edit'); input('x'.repeat(5 * 1024 * 1024)); click('submit')
    await vi.waitFor(()=>expect(status()).toContain('超过 5 MiB'))
    expect(send).not.toHaveBeenCalled()
    input('中文修改🧪'); click('submit')
    await vi.waitFor(() => expect(status()).toContain('已送达'))
    expect(JSON.parse(send.mock.calls[0][1].body as string).edits[0].afterMarkdown).toBe('中文修改🧪')
  })
  it('retries identical bytes after an unknown result, then creates a new submission for newer edits', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      bodies.push(init.body)
      if(bodies.length === 1) throw new Error('offline')
      return Response.json({})
    }))
    await projectShareBrowser(new Marked())
    click('edit'); input('first change'); click('submit')
    await vi.waitFor(() => expect(status()).toContain('结果未知'))
    input('second change'); click('submit')
    await vi.waitFor(() => expect(status()).toContain('已送达'))
    expect(bodies[1]).toBe(bodies[0])
    click('submit')
    await vi.waitFor(() => expect(bodies).toHaveLength(3))
    expect(JSON.parse(bodies[2]).submissionId).not.toBe(JSON.parse(bodies[0]).submissionId)
    expect(JSON.parse(bodies[2]).edits[0].afterMarkdown).toBe('second change')
  })
  it('takes annotations from the published baseline while preserving newer drafts', async () => {
    await projectShareBrowser(new Marked())
    const prompt = vi.fn(() => '评论')
    vi.stubGlobal('prompt', prompt)
    click('edit'); input('new draft')
    click('annotate')
    expect(status()).toContain('查看发布原文')
    expect(prompt).not.toHaveBeenCalled()
    click('baseline')
    const range = document.createRange()
    range.selectNodeContents($('document').querySelector('h1')!)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    click('annotate')
    await vi.waitFor(() => expect(status()).toContain('标注已保存'))
    expect([...values.entries()].find(([key])=>key.includes(':draft2-notes:'))?.[1]).toMatchObject([{ path: 'README.md', selector:{exact:'方案'}, comment: '评论' }])
    expect([...values.entries()].find(([key])=>key.includes(':draft2:'))?.[1].after['README.md']).toBe('new draft')
  })
  it('disables submission after a local write failure while retaining the draft for export', async () => {
    history.replaceState(null,'','/')
    values.set('project_1:token','cached-token')
    fakeDatabase(0,false,true)
    const send=vi.fn(); vi.stubGlobal('fetch',send)
    await projectShareBrowser(new Marked())
    click('edit'); input('memory draft')
    await vi.waitFor(()=>expect(status()).toContain('disk full'))
    expect(($('submit') as HTMLButtonElement).disabled).toBe(true)
    expect(($('export') as HTMLButtonElement).disabled).toBe(false)
    expect(($('editor') as HTMLTextAreaElement).value).toBe('memory draft')
    expect(send).not.toHaveBeenCalled()
  })
  it('keeps an exportable editor when storage is unavailable', async () => {
    fakeDatabase(0, true)
    await projectShareBrowser(new Marked())
    expect(status()).toContain('本地存储不可用')
    expect(($('edit') as HTMLButtonElement).disabled).toBe(false)
    click('edit'); input('unsaved')
    await vi.waitFor(() => expect(status()).toContain('未保存'))
    expect(($('submit') as HTMLButtonElement).disabled).toBe(true)
    expect(($('editor') as HTMLTextAreaElement).value).toBe('unsaved')
    expect(document.title).toBe('README · 可编辑')
    expect(($('export') as HTMLButtonElement).disabled).toBe(false)
  })
})

// Exercise the real transaction semantics and the exact function serialized in HTML.
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
async function idb(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const op=indexedDB.open('notemd-project-sharing',1)
    op.onupgradeneeded=()=>op.result.createObjectStore('data')
    op.onsuccess=()=>resolve(op.result); op.onerror=()=>reject(op.error)
  })
  try { return await new Promise<any>((resolve,reject)=> {
    const tx=db.transaction('data',mode), op=run(tx.objectStore('data'))
    tx.oncomplete=()=>resolve(op.result); tx.onabort=tx.onerror=()=>reject(tx.error)
  }) } finally { db.close() }
}
async function serialized() {
  const scripts=Array.from(document.querySelectorAll('script'))
  new Function(scripts[scripts.length-1].textContent!)()
  await vi.waitFor(()=>expect(($('edit') as HTMLButtonElement).disabled).toBe(false))
}
const draftKey='project_1:draft2:lineage-one'
const draftFixture=()=>({v:2,lineageId:'lineage-one',snapshotId:'snapshot-old',base:{'README.md':{hash:'f'.repeat(64),markdown:'旧原文 风险'}},after:{'README.md':'旧稿 修改'},annotationKinds:{},rebasedFrom:'snapshot-earlier',previous:{snapshotId:'snapshot-earlier',base:{},after:{}}})

describe('versioned drafts in serialized browser',()=> {
  beforeEach(()=>vi.stubGlobal('indexedDB',new IDBFactory()))
  it('atomically migrates current legacy originals and form notes, without embedding notes in after',async()=> {
    await idb('readwrite',store=>store.put({drafts:{'README.md':'changed'},annotations:[{path:'README.md',quote:'方案',comment:'review'}]},'project_1:snapshot_1'))
    await serialized()
    const keys=await idb('readonly',store=>store.getAllKeys())
    const key=keys.find((key:string)=>key.startsWith('project_1:draft2:'))
    expect(key).toBeDefined()
    const draft=await idb('readonly',store=>store.get(key))
    expect(draft).toMatchObject({v:2,snapshotId:'snapshot_1',base:{'README.md':{hash:snapshot.files[0].hash,markdown:snapshot.files[0].markdown}},after:{'README.md':'changed'},annotationKinds:{}})
    expect(await idb('readonly',store=>store.get('project_1:snapshot_1'))).toBeUndefined()
    expect(await idb('readonly',store=>store.get(key.replace(':draft2:',':draft2-notes:')))).toMatchObject([{selector:{exact:'方案',start:2,end:4},comment:'review'}])
  })
  it('retains stale baseline, frozen bytes across edits/reload and submission lineage',async()=> {
    await idb('readwrite',store=>store.put(draftFixture(),draftKey))
    const bodies:string[]=[]
    vi.stubGlobal('fetch',vi.fn(async (_url,init)=>{ if(init?.method==='POST'){bodies.push(init.body);if(bodies.length===1)throw Error('offline')}return Response.json({}) }))
    await serialized()
    expect($('old-drafts').textContent).toContain('你在旧版本上有未提交的修改')
    expect(($('editor') as HTMLTextAreaElement).value).toBe('旧稿 修改')
    click('submit'); await vi.waitFor(()=>expect(status()).toContain('结果未知'))
    click('edit'); input('newer input'); ($('name') as HTMLInputElement).value='changed name'
    click('submit'); await vi.waitFor(()=>expect(status()).toContain('已送达'))
    expect(bodies[1]).toBe(bodies[0])
    expect(JSON.parse(bodies[0])).toMatchObject({schemaVersion:2,snapshotId:'snapshot-old',client:{kind:'browser-fallback'},rebasedFrom:'snapshot-earlier',edits:[{baseHash:'f'.repeat(64),afterMarkdown:'旧稿 修改'}]})
    const saved=await idb('readonly',store=>store.get(draftKey))
    expect(saved.lastSubmissionId).toBe(JSON.parse(bodies[0]).submissionId); expect(saved.previous).toBeUndefined()
    click('submit'); await vi.waitFor(()=>expect(bodies).toHaveLength(3))
    expect(JSON.parse(bodies[2]).supersedes).toBe(saved.lastSubmissionId)
    expect(JSON.parse(bodies[2]).edits[0].afterMarkdown).toBe('newer input')
  })
  it('exports unmatched legacy only unless an exact frozen v1 body exists',async()=> {
    await idb('readwrite',store=>store.put({drafts:{'README.md':'lost base'},annotations:[]},'project_1:old'))
    await serialized()
    expect($('old-drafts').textContent).toContain('无法取得旧版本原文')
    expect($('old-drafts').textContent).toContain('导出草稿')
    expect($('old-drafts').textContent).not.toContain('按旧版本提交')
  })
  it('forces no-store version checks before send and keeps edits after revocation',async()=> {
    const data=JSON.parse($('project-data').textContent!); data.versionUrl='https://share.test/project/slug/version'; $('project-data').textContent=JSON.stringify(data)
    const send=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({snapshotId:'snapshot-new'})); vi.stubGlobal('fetch',send)
    await serialized(); await vi.waitFor(()=>expect($('version-notice').textContent).toContain('分享者已发布新版本'))
    document.dispatchEvent(new Event('visibilitychange')); expect(send).toHaveBeenCalledTimes(1)
    send.mockResolvedValue(new Response('',{status:410}))
    click('edit'); input('retained'); click('submit')
    await vi.waitFor(()=>expect(status()).toContain('已失效'))
    expect(send).toHaveBeenCalledTimes(2); expect(($('submit') as HTMLButtonElement).disabled).toBe(true)
    expect(($('editor') as HTMLTextAreaElement).value).toBe('retained'); expect(send.mock.calls[0][1]).toMatchObject({cache:'no-store'})
  })
  it('fetches recent twenty receipts with at most four concurrent and displays replies as text',async()=> {
    await idb('readwrite',store=>store.put(Array.from({length:25},(_,i)=>'id-'+i),'project_1:submitted'))
    let active=0,max=0; const ids:string[]=[]
    vi.stubGlobal('fetch',vi.fn(async(url)=>{ids.push(url);active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return url.endsWith('id-24')?new Response('',{status:404}):Response.json({outcome:'partial',files:[{accepted:3,total:5}],reply:'<img src=x onerror=alert(1)>'})}))
    await serialized(); await vi.waitFor(()=>expect(ids).toHaveLength(20)); await vi.waitFor(()=>expect($('my-submissions').textContent).toContain('已送达，待处理'))
    expect(max).toBeLessThanOrEqual(4);expect(ids.some(id=>id.endsWith('id-4'))).toBe(false)
    expect($('my-submissions').textContent).toContain('已合入 3/5 处');expect($('my-submissions').querySelector('img')).toBeNull()
  })
  it('leaves legacy key and both new keys untouched when migration transaction aborts',async()=> {
    history.replaceState(null,'','/')
    await idb('readwrite',store=>store.put('cached-token','project_1:token'))
    const old={drafts:{'README.md':'recoverable'},annotations:[{path:'README.md',quote:'方案',comment:'note'}]}
    await idb('readwrite',store=>store.put(old,'project_1:snapshot_1'))
    const put=FakeObjectStore.prototype.put
    const spy=vi.spyOn(FakeObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){
      const result=put.call(this,value,key)
      if(String(key).includes(':draft2-notes:')) this.transaction.abort()
      return result
    })
    try {
      await serialized()
      expect(status()).toContain('本地存储不可用')
      expect(await idb('readonly',store=>store.get('project_1:snapshot_1'))).toEqual(old)
      expect((await idb('readonly',store=>store.getAllKeys())).filter((key:string)=>key.includes(':draft2'))).toEqual([])
      expect(($('editor') as HTMLTextAreaElement).value).toBe('recoverable')
      expect(($('export') as HTMLButtonElement).disabled).toBe(false)
    } finally {spy.mockRestore()}
  })
  it('replays exact old v1 body without manufacturing a baseline or losing current work',async()=> {
    const body='{ "schemaVersion":1,"project_id":"project_1","snapshotId":"old","submissionId":"v1-id","edits":[],"annotations":[] }'
    await idb('readwrite',store=>store.put({drafts:{'README.md':'legacy'},annotations:[],pending:{body}},'project_1:old'))
    const send=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({}));vi.stubGlobal('fetch',send)
    await serialized()
    click('edit');input('current work')
    const button=Array.from($('old-drafts').querySelectorAll('button')).find(button=>button.textContent==='按旧版本提交')!
    button.click();await vi.waitFor(()=>expect(status()).toContain('已送达'))
    expect(send.mock.calls[0][1].body).toBe(body)
    expect(await idb('readonly',store=>store.get('project_1:submitted'))).toEqual(['v1-id'])
    expect((await idb('readonly',store=>store.getAllKeys())).some((key:string)=>key.includes(':draft2:'))).toBe(true)
    expect(($('editor') as HTMLTextAreaElement).value).toBe('current work')
  })
  it('serialized v2 bundle retains optional file recovery until fallback textarea changes its raw', async()=> {
    const candidate=draftFixture()
    const recovery={v:1,sourceHash:'cache-hash',sourceRevision:7,bindings:[{rootOrdinal:0,id:'cached'}]}
    await idb('readwrite',store=>store.put({...candidate,editorFiles:{'README.md':recovery}},draftKey))
    await serialized()
    expect((await idb('readonly',store=>store.get(draftKey))).editorFiles['README.md']).toEqual(recovery)
    click('edit');input('new exact raw')
    await vi.waitFor(async()=>expect((await idb('readonly',store=>store.get(draftKey))).after['README.md']).toBe('new exact raw'))
    expect((await idb('readonly',store=>store.get(draftKey))).editorFiles['README.md']).toBeUndefined()
  })
  it('restores pending exact bytes on reload despite later name/message/input edits',async()=> {
    const candidate=draftFixture()
    const body=JSON.stringify({schemaVersion:2,project_id:'project_1',snapshotId:'snapshot-old',submissionId:'frozen',edits:[{path:'README.md',baseHash:'f'.repeat(64),afterMarkdown:'frozen text'}],annotations:[],client:{kind:'browser-fallback'}})
    await idb('readwrite',store=>store.put({...candidate,pending:{submissionId:'frozen',body}},draftKey))
    vi.stubGlobal('fetch',vi.fn(async(_url:string,_init:RequestInit)=>new Response('',{status:503})))
    await serialized();click('edit');input('later text');($('name') as HTMLInputElement).value='later name';$('name').dispatchEvent(new Event('input'));($('message') as HTMLInputElement).value='later message';$('message').dispatchEvent(new Event('input'))
    click('submit');await vi.waitFor(()=>expect(status()).toContain('结果未知'))
    expect((await idb('readonly',store=>store.get(draftKey))).pending.body).toBe(body)
    // A newly serialized runtime recovers the same database, like a page reload.
    const html=buildProjectBundle(snapshot,'https://share.test/feedback/project_1')
    document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('</body>'))
    const data=JSON.parse($('project-data').textContent!);delete data.versionUrl;$('project-data').textContent=JSON.stringify(data)
    const send=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({}));vi.stubGlobal('fetch',send)
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
    expect(send.mock.calls.find(call=>call[1]?.method==='POST')![1].body).toBe(body)
    expect((await idb('readonly',store=>store.get(draftKey))).after['README.md']).toBe('later text')
    expect(($('name') as HTMLInputElement).value).toBe('later name')
  })
  it('does not attach a current-only file baseline to an old snapshot',async()=> {
    await idb('readwrite',store=>store.put(draftFixture(),draftKey))
    await serialized();click('file-toggle')
    document.querySelector<HTMLButtonElement>('[data-file="Research.md"]')!.click()
    expect(($('edit') as HTMLButtonElement).disabled).toBe(true)
    expect(status()).toContain('没有旧版本原文')
    input('must not join old draft')
    expect((await idb('readonly',store=>store.get(draftKey))).base['Research.md']).toBeUndefined()
  })
  it('keeps latest network/commit-time input and commits FIFO200 without reviving pending',async()=> {
    await idb('readwrite',store=>store.put(draftFixture(),draftKey))
    await idb('readwrite',store=>store.put(Array.from({length:200},(_,i)=>'previous-'+i),'project_1:submitted'))
    let finish:(response:Response)=>void=()=>{}
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>init?.method==='POST'?new Promise<Response>(resolve=>{finish=resolve}):new Response('',{status:404})))
    await serialized();click('edit');click('submit')
    await vi.waitFor(()=>expect(status()).toContain('提交中'))
    input('during network')
    const put=FakeObjectStore.prototype.put
    const spy=vi.spyOn(FakeObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){
      const result=put.call(this,value,key)
      if(key==='project_1:submitted') queueMicrotask(()=>input('during durable completion'))
      return result
    })
    try {
      finish(Response.json({}));await vi.waitFor(()=>expect($('my-submissions').textContent).toContain('已送达，待处理'))
      await vi.waitFor(async()=>expect((await idb('readonly',store=>store.get(draftKey))).after['README.md']).toBe('during durable completion'))
      const saved=await idb('readonly',store=>store.get(draftKey))
      expect(saved.pending).toBeUndefined();expect(saved.previous).toBeUndefined()
      const submitted=await idb('readonly',store=>store.get('project_1:submitted'))
      expect(submitted).toHaveLength(200);expect(submitted[0]).toBe('previous-1');expect(submitted[199]).toBe(saved.lastSubmissionId)
    } finally {spy.mockRestore()}
  })
  it('never claims delivered when completion persistence fails and keeps pending durable',async()=> {
    await idb('readwrite',store=>store.put(draftFixture(),draftKey))
    const put=FakeObjectStore.prototype.put
    const spy=vi.spyOn(FakeObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){
      const result=put.call(this,value,key)
      if(key==='project_1:submitted') this.transaction.abort()
      return result
    })
    vi.stubGlobal('fetch',vi.fn(async(_url:string,_init:RequestInit)=>Response.json({})))
    try {
      await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('结果未知'))
      expect(status()).not.toContain('已送达')
      const saved=await idb('readonly',store=>store.get(draftKey))
      expect(saved.pending.body).toContain('旧稿 修改');expect(saved.previous).toBeDefined()
      expect(await idb('readonly',store=>store.get('project_1:submitted'))).toBeUndefined()
    } finally {spy.mockRestore()}
  })
  it('anchors form notes with UTF16 coordinates and exact 32-unit context; rejects ambiguous quotes',async()=> {
    const data=JSON.parse($('project-data').textContent!)
    const markdown='😀'+'前'.repeat(40)+'风险'+'后'.repeat(40)+'\n\n重复 重复'
    data.snapshot.files[0].markdown=markdown;$('project-data').textContent=JSON.stringify(data)
    vi.stubGlobal('prompt',()=> '审阅')
    const send=vi.fn(async(_url:string,_init:RequestInit)=>Response.json({}));vi.stubGlobal('fetch',send)
    await serialized()
    const select=(quote:string)=> {
      const node=$('document').querySelector('p')!.firstChild!, text=node.textContent!,start=text.indexOf(quote)
      const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+quote.length)
      window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range)
    }
    select('风险');click('annotate');await vi.waitFor(()=>expect(status()).toContain('标注已保存'))
    ;($('name') as HTMLInputElement).value='Alice';($('message') as HTMLInputElement).value='说明';$('message').dispatchEvent(new Event('input'))
    click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
    const body=JSON.parse(send.mock.calls[0][1].body as string)
    expect(body).toMatchObject({client:{kind:'browser-fallback'},contributor:{name:'Alice'},message:'说明',annotations:[{selector:{exact:'风险',start:42,end:44,prefix:'前'.repeat(32),suffix:'后'.repeat(32)}}]})
    const node=$('document').querySelectorAll('p')[1].firstChild!,range=document.createRange();range.setStart(node,0);range.setEnd(node,2);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range)
    click('annotate');expect(status()).toContain('存在多处')
    click('submit');await vi.waitFor(()=>expect(status()).toContain('没有新的修改或标注'));expect(send).toHaveBeenCalledTimes(1)
  })

  it('retains cumulative sent content and notes, reloads without duplicate send, and supersedes A→B→C',async()=> {
    const fixture=draftFixture()
    fixture.after['README.md']='A 风险'
    await idb('readwrite',store=>store.put(fixture,draftKey))
    await idb('readwrite',store=>store.put([{path:'README.md',selector:{exact:'风险'},comment:'note'}],'project_1:draft2-notes:lineage-one'))
    const bodies:string[]=[]
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{bodies.push(init.body);return Response.json({})}))
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
    expect(($('editor') as HTMLTextAreaElement).value).toBe('A 风险')
    expect((await idb('readonly',store=>store.get(draftKey))).after['README.md']).toBe('A 风险')
    expect((await idb('readonly',store=>store.get('project_1:draft2-notes:lineage-one')))).toHaveLength(1)
    const sent=await idb('readonly',store=>store.get('project_1:draft2-sent:lineage-one'))
    expect(Object.keys(sent).sort()).toEqual(['contentHash','submissionId']);expect(sent.contentHash).toMatch(/^[a-f0-9]{64}$/)
    const html=buildProjectBundle(snapshot,'https://share.test/feedback/project_1')
    document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('</body>'))
    const data=JSON.parse($('project-data').textContent!);delete data.versionUrl;$('project-data').textContent=JSON.stringify(data)
    const send=vi.fn(async(_url,init)=>{if(init?.method==='POST')bodies.push(init.body);return Response.json({})});vi.stubGlobal('fetch',send)
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('没有新的修改或标注'))
    expect(bodies).toHaveLength(1)
    expect($('old-drafts').textContent).toContain('已提交的草稿')
    click('edit');input('B 风险');click('submit');await vi.waitFor(()=>expect(bodies).toHaveLength(2));await vi.waitFor(()=>expect(status()).toContain('已送达'))
    input('C 风险');click('submit');await vi.waitFor(()=>expect(bodies).toHaveLength(3));await vi.waitFor(()=>expect(status()).toContain('已送达'))
    expect(JSON.parse(bodies[1]).supersedes).toBe(JSON.parse(bodies[0]).submissionId)
    expect(JSON.parse(bodies[2]).supersedes).toBe(JSON.parse(bodies[1]).submissionId)
    expect(JSON.parse(bodies[2]).edits).toEqual([{path:'README.md',baseHash:'f'.repeat(64),afterMarkdown:'C 风险'}])
    expect(JSON.parse(bodies[2]).annotations).toHaveLength(1)
    ;($('name') as HTMLInputElement).value='nickname only';$('name').dispatchEvent(new Event('input'));click('submit')
    await vi.waitFor(()=>expect(status()).toContain('没有新的修改或标注'));expect(bodies).toHaveLength(3)
    ;($('message') as HTMLInputElement).value='updated explanation';$('message').dispatchEvent(new Event('input'));click('submit')
    await vi.waitFor(()=>expect(bodies).toHaveLength(4));await vi.waitFor(()=>expect(status()).toContain('已送达'))
    expect(JSON.parse(bodies[3])).toMatchObject({message:'updated explanation',supersedes:JSON.parse(bodies[2]).submissionId,edits:[{afterMarkdown:'C 风险'}]})
  })
  it('keeps unmatched legacy source unchanged after replay and suppresses it on reload via submitted IDs',async()=> {
    const body=JSON.stringify({schemaVersion:1,project_id:'project_1',snapshotId:'old',submissionId:'legacy-id',edits:[],annotations:[]})
    const old={drafts:{'README.md':'newer local input'},annotations:[],pending:{body}}
    await idb('readwrite',store=>store.put(old,'project_1:old'))
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({})))
    await serialized();Array.from($('old-drafts').querySelectorAll('button')).find(button=>button.textContent==='按旧版本提交')!.click()
    await vi.waitFor(()=>expect(status()).toContain('已送达'))
    expect(await idb('readonly',store=>store.get('project_1:old'))).toEqual(old)
    const html=buildProjectBundle(snapshot,'https://share.test/feedback/project_1')
    document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('</body>'))
    const data=JSON.parse($('project-data').textContent!);delete data.versionUrl;$('project-data').textContent=JSON.stringify(data)
    await serialized()
    expect($('old-drafts').textContent).not.toContain('按旧版本提交')
    expect($('old-drafts').textContent).toContain('导出草稿')
  })
  it('throttles visible checks until sixty seconds and quietly tolerates 404/network errors',async()=> {
    const data=JSON.parse($('project-data').textContent!);data.versionUrl='https://share.test/project/slug/version';$('project-data').textContent=JSON.stringify(data)
    let now=0;const clock=vi.spyOn(Date,'now').mockImplementation(()=>now)
    const send=vi.fn(async()=>new Response('',{status:404}));vi.stubGlobal('fetch',send)
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
    try {
      await serialized();await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1))
      now=59999;document.dispatchEvent(new Event('visibilitychange'));expect(send).toHaveBeenCalledTimes(1)
      now=60000;document.dispatchEvent(new Event('visibilitychange'));await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(2))
      expect($('version-notice').hidden).toBe(true)
      send.mockRejectedValueOnce(Error('offline'));now=120000;document.dispatchEvent(new Event('visibilitychange'));await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(3))
      expect($('version-notice').hidden).toBe(true);expect(status()).toBe('')
    } finally {clock.mockRestore()}
  })

  it('migrates v1 form notes but preserves frozen v1 wire bytes and deduplicates after success/reload',async()=> {
    const payload={schemaVersion:1,project_id:'project_1',snapshotId:'snapshot_1',submissionId:'legacy-current',edits:[{path:'README.md',baseHash:snapshot.files[0].hash,afterMarkdown:'legacy sent text 方案'}],annotations:[{path:'README.md',quote:'方案',comment:'review'}],name:'old name'}
    const body=JSON.stringify(payload)
    await idb('readwrite',store=>store.put({drafts:{'README.md':'legacy sent text 方案'},annotations:payload.annotations,pending:{body}},'project_1:snapshot_1'))
    const bodies:string[]=[]
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST')bodies.push(init.body);return Response.json({})}))
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
    expect(bodies).toEqual([body]);expect(($('editor') as HTMLTextAreaElement).value).toBe('legacy sent text 方案')
    const html=buildProjectBundle(snapshot,'https://share.test/feedback/project_1')
    document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('</body>'))
    const data=JSON.parse($('project-data').textContent!);delete data.versionUrl;$('project-data').textContent=JSON.stringify(data)
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('没有新的修改或标注'))
    expect(bodies).toEqual([body])
  })

  it('keeps lastSubmissionId and notes attached to the selected lineage',async()=> {
    const old={...draftFixture(),lastSubmissionId:'old-previous'}
    const current={...draftFixture(),lineageId:'current-lineage',snapshotId:'snapshot_1',lastSubmissionId:'current-previous',after:{'README.md':'current restored'}}
    await idb('readwrite',store=>store.put(old,draftKey))
    await idb('readwrite',store=>store.put(current,'project_1:draft2:current-lineage'))
    await idb('readwrite',store=>store.put([{path:'README.md',selector:{exact:'风险'},comment:'old note'}],'project_1:draft2-notes:lineage-one'))
    await idb('readwrite',store=>store.put([{path:'README.md',selector:{exact:'current'},comment:'current note'}],'project_1:draft2-notes:current-lineage'))
    const bodies:string[]=[]
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST')bodies.push(init.body);return Response.json({})}))
    await serialized();expect(($('editor') as HTMLTextAreaElement).value).toBe('current restored')
    Array.from($('old-drafts').querySelectorAll('button')).find(button=>button.textContent==='按旧版本提交')!.click()
    await vi.waitFor(()=>expect(($('editor') as HTMLTextAreaElement).value).toBe('旧稿 修改'))
    click('edit');input('old explicitly edited 风险');click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
    const body=JSON.parse(bodies[0]);expect(body.supersedes).toBe('old-previous');expect(body.annotations[0].comment).toBe('old note')
    expect(body.snapshotId).toBe('snapshot-old')
    expect((await idb('readonly',store=>store.get('project_1:draft2:current-lineage'))).lastSubmissionId).toBe('current-previous')
  })

  it('fix1 I1: input during gated real notes read remains in original lineage across restart',async()=> {
    const old=draftFixture()
    const current={...draftFixture(),lineageId:'current-lineage',snapshotId:'snapshot_1',after:{'README.md':'CURRENT TEXT'}}
    const oldNotes=[{path:'README.md',selector:{exact:'风险'},comment:'OLD NOTE'}]
    const currentNotes=[{path:'README.md',selector:{exact:'current'},comment:'CURRENT NOTE'}]
    await idb('readwrite',store=>store.put(old,draftKey))
    await idb('readwrite',store=>store.put(current,'project_1:draft2:current-lineage'))
    await idb('readwrite',store=>store.put(oldNotes,'project_1:draft2-notes:lineage-one'))
    await idb('readwrite',store=>store.put(currentNotes,'project_1:draft2-notes:current-lineage'))
    await serialized();click('edit')
    let unlock=()=>{},started=()=>{}
    const gate=new Promise<void>(resolve=>{unlock=resolve}),reading=new Promise<void>(resolve=>{started=resolve})
    const get=FakeObjectStore.prototype.get
    let gated=false
    const spy=vi.spyOn(FakeObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,key){
      const op=get.call(this,key)
      if(key==='project_1:draft2-notes:lineage-one'&&!gated) {
        gated=true;let complete:((event:Event)=>void)|undefined
        Object.defineProperty(this.transaction,'oncomplete',{configurable:true,set(fn){complete=fn}})
        this.transaction.addEventListener('complete',event=>{started();void gate.then(()=>complete?.(event))})
      }
      return op
    })
    try {
      Array.from($('old-drafts').querySelectorAll('button')).find(button=>button.textContent==='按旧版本提交')!.click()
      await reading;input('CURRENT INPUT DURING LOAD')
      ;($('message') as HTMLInputElement).value='CURRENT MESSAGE DURING LOAD';$('message').dispatchEvent(new Event('input'))
      await vi.waitFor(async()=>expect((await idb('readonly',store=>store.get('project_1:draft2:current-lineage'))).after['README.md']).toBe('CURRENT INPUT DURING LOAD'))
      unlock();await vi.waitFor(()=>expect($('comments').textContent).toContain('OLD NOTE'))
      expect(await idb('readonly',store=>store.get('project_1:draft2-notes:lineage-one'))).toEqual(oldNotes)
      expect((await idb('readonly',store=>store.get(draftKey))).after).toEqual(old.after)
      expect((await idb('readonly',store=>store.get('project_1:draft2:current-lineage'))).message).toBe('CURRENT MESSAGE DURING LOAD')
      expect(await idb('readonly',store=>store.get('project_1:draft2-notes:current-lineage'))).toEqual(currentNotes)
    } finally {unlock();spy.mockRestore()}
    const html=buildProjectBundle(snapshot,'https://share.test/feedback/project_1')
    document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('</body>'))
    const data=JSON.parse($('project-data').textContent!);delete data.versionUrl;$('project-data').textContent=JSON.stringify(data)
    await serialized();expect(($('editor') as HTMLTextAreaElement).value).toBe('CURRENT INPUT DURING LOAD')
    Array.from($('old-drafts').querySelectorAll('button')).find(button=>button.textContent==='按旧版本提交')!.click()
    await vi.waitFor(()=>expect($('comments').textContent).toContain('OLD NOTE'))
    expect(($('editor') as HTMLTextAreaElement).value).toBe(old.after['README.md'])
  })
  it.each(['deleted','renamed'])('fix1 I2: restores %s old file from draft base, edits/submits original snapshot and exports',async(kind)=> {
    const oldPath='old/deleted.md',base='# OLD BASE\n\n风险',text='# OLD DRAFT'
    const old={v:2,lineageId:'missing-lineage',snapshotId:'S1',base:{[oldPath]:{hash:'f'.repeat(64),markdown:base}},after:{[oldPath]:text},annotationKinds:{}}
    if(kind==='renamed') {
      const data=JSON.parse($('project-data').textContent!);data.snapshot.files.push({path:'new/renamed.md',hash:'e'.repeat(64),markdown:'# NEW NAME',bytes:10});$('project-data').textContent=JSON.stringify(data)
    }
    await idb('readwrite',store=>store.put(old,'project_1:draft2:missing-lineage'))
    const send=vi.fn(async(_url:string,init:RequestInit)=>Response.json({}));vi.stubGlobal('fetch',send)
    let blob:Blob|undefined
    const url=vi.spyOn(URL,'createObjectURL').mockImplementation(value=>{blob=value as Blob;return 'blob:test'})
    const anchor=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    try {
      await serialized()
      Array.from($('old-drafts').querySelectorAll('button')).find(button=>button.textContent==='按旧版本提交')!.click()
      await vi.waitFor(()=>expect(($('editor') as HTMLTextAreaElement).value).toBe(text))
      await vi.waitFor(()=>expect(($('submit') as HTMLButtonElement).disabled).toBe(false))
      expect(document.querySelector('[data-file="old/deleted.md"]')).not.toBeNull()
      document.querySelector<HTMLButtonElement>('[data-file="README.md"]')!.click()
      expect(($('edit') as HTMLButtonElement).disabled).toBe(true)
      document.querySelector<HTMLButtonElement>('[data-file="old/deleted.md"]')!.click()
      expect(($('edit') as HTMLButtonElement).disabled).toBe(false)
      click('baseline');expect($('document').textContent).toContain('OLD BASE')
      click('edit');input('# EDITED OLD FILE');click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
      const payload=JSON.parse(send.mock.calls[0][1].body as string)
      expect(payload).toMatchObject({snapshotId:'S1',edits:[{path:oldPath,baseHash:'f'.repeat(64),afterMarkdown:'# EDITED OLD FILE'}]})
      click('export');const exported=JSON.parse(await blob!.text())
      expect(exported.draft.base[oldPath].markdown).toBe(base);expect(exported.draft.after[oldPath]).toBe('# EDITED OLD FILE')
    } finally {url.mockRestore();anchor.mockRestore()}
  })

  it('fix1 I1: queued input saves keep original ownership after candidate reads finish',async()=> {
    const old=draftFixture(),current={...draftFixture(),lineageId:'current-lineage',snapshotId:'snapshot_1',after:{'README.md':'CURRENT TEXT'}}
    const oldNotes=[{path:'README.md',selector:{exact:'风险'},comment:'OLD NOTE'}],currentNotes=[{path:'README.md',selector:{exact:'current'},comment:'CURRENT NOTE'}]
    await idb('readwrite',store=>store.put(old,draftKey));await idb('readwrite',store=>store.put(current,'project_1:draft2:current-lineage'))
    await idb('readwrite',store=>store.put(oldNotes,'project_1:draft2-notes:lineage-one'));await idb('readwrite',store=>store.put(currentNotes,'project_1:draft2-notes:current-lineage'))
    await serialized();click('edit')
    let releaseRead=()=>{},releaseWrite=()=>{},readStarted=()=>{},writeStarted=()=>{}
    const readGate=new Promise<void>(resolve=>{releaseRead=resolve}),writeGate=new Promise<void>(resolve=>{releaseWrite=resolve})
    const reading=new Promise<void>(resolve=>{readStarted=resolve}),writing=new Promise<void>(resolve=>{writeStarted=resolve})
    const pause=(tx:IDBTransaction,gate:Promise<void>,started:()=>void)=> {
      let complete:((event:Event)=>void)|undefined
      Object.defineProperty(tx,'oncomplete',{configurable:true,set(fn){complete=fn}})
      tx.addEventListener('complete',event=>{started();void gate.then(()=>complete?.(event))})
    }
    let readPaused=false,writePaused=false
    const get=FakeObjectStore.prototype.get,put=FakeObjectStore.prototype.put
    const getSpy=vi.spyOn(FakeObjectStore.prototype,'get').mockImplementation(function(this:IDBObjectStore,key){const op=get.call(this,key);if(key==='project_1:draft2-notes:lineage-one'&&!readPaused){readPaused=true;pause(this.transaction,readGate,readStarted)}return op})
    const putSpy=vi.spyOn(FakeObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){const op=put.call(this,value,key);if(key==='project_1:draft2:current-lineage'&&!writePaused){writePaused=true;pause(this.transaction,writeGate,writeStarted)}return op})
    try {
      Array.from($('old-drafts').querySelectorAll('button')).find(button=>button.textContent==='按旧版本提交')!.click()
      await reading;input('first current input');await writing
      input('queued current input');releaseRead()
      await vi.waitFor(()=>expect($('comments').textContent).toContain('OLD NOTE'))
      releaseWrite()
      await vi.waitFor(async()=>expect((await idb('readonly',store=>store.get('project_1:draft2:current-lineage'))).after['README.md']).toBe('queued current input'))
      expect((await idb('readonly',store=>store.get(draftKey))).after).toEqual(old.after)
      expect(await idb('readonly',store=>store.get('project_1:draft2-notes:lineage-one'))).toEqual(oldNotes)
      expect(await idb('readonly',store=>store.get('project_1:draft2-notes:current-lineage'))).toEqual(currentNotes)
    } finally {releaseRead();releaseWrite();getSpy.mockRestore();putSpy.mockRestore()}
  })

  it.each([
    ['name', 'n'.repeat(81), '署名'], ['name', 'x\u0085', '署名'],
    ['message', '😀'.repeat(1000)+'x', '说明'], ['message', 'x\0', '说明'],
  ])('final fix I1: validates %s before freezing and accepts corrected input (%s)',async(field,value,label)=> {
    await idb('readwrite',store=>store.put(draftFixture(),draftKey))
    const bodies:string[]=[]
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST')bodies.push(init.body);return Response.json({})}))
    await serialized()
    ;($(field) as HTMLInputElement).value=value;$(field).dispatchEvent(new Event('input'))
    click('submit');await vi.waitFor(()=>expect(($('submit') as HTMLButtonElement).disabled).toBe(false))
    expect(status()).toContain(label);expect(bodies).toHaveLength(0)
    expect((await idb('readonly',store=>store.get(draftKey))).pending).toBeUndefined()
    ;($(field) as HTMLInputElement).value='corrected';$(field).dispatchEvent(new Event('input'))
    click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'));expect(bodies).toHaveLength(1)
  })

  it('final fix I1: blocks oversized stored notes without freezing; explicit removal recovers',async()=> {
    const exact='x'.repeat(2001),fixture=draftFixture()
    fixture.base['README.md'].markdown=exact;fixture.after['README.md']=exact+' edited'
    await idb('readwrite',store=>store.put(fixture,draftKey))
    await idb('readwrite',store=>store.put([{path:'README.md',selector:{exact},comment:'retained'}],'project_1:draft2-notes:lineage-one'))
    const send=vi.fn(async()=>Response.json({}));vi.stubGlobal('fetch',send)
    await serialized();click('submit');await vi.waitFor(()=>expect(($('submit') as HTMLButtonElement).disabled).toBe(false))
    expect(send).not.toHaveBeenCalled();expect(status()).toContain('批注')
    expect((await idb('readonly',store=>store.get(draftKey))).pending).toBeUndefined()
    expect($('comments').textContent).toContain('retained')
    $('comments').querySelector<HTMLButtonElement>('button')!.click()
    await vi.waitFor(()=>expect($('comments').querySelector('blockquote')).toBeNull())
    click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
  })

  it('final fix I1: invalid pending remains byte equal on unknown delivery; only proven 400 allows explicit retirement',async()=> {
    const body=JSON.stringify({schemaVersion:2,project_id:'project_1',snapshotId:'snapshot-old',submissionId:'invalid-old',contributor:{name:'n'.repeat(81)},edits:[{path:'README.md',baseHash:'f'.repeat(64),afterMarkdown:'frozen'}],annotations:[]})
    await idb('readwrite',store=>store.put({...draftFixture(),pending:{submissionId:'invalid-old',body}},draftKey))
    const bodies:string[]=[];let code=503
    vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST')bodies.push(init.body);return code===200?Response.json({}):new Response('',{status:code})}))
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('结果未知'))
    expect(document.getElementById('correct-rejected')?.hidden??true).toBe(true)
    click('edit');input('corrected live');($('name') as HTMLInputElement).value='Alice'
    code=400;click('submit');await vi.waitFor(()=>expect(status()).toContain('400'))
    expect(bodies).toEqual([body,body]);expect((await idb('readonly',store=>store.get(draftKey))).pending.body).toBe(body)
    const recovery=$('correct-rejected') as HTMLButtonElement
    expect(recovery).not.toBeNull();expect(recovery.hidden).toBe(false)
    recovery.click();await vi.waitFor(()=>expect(status()).toContain('已解除冻结'))
    expect((await idb('readonly',store=>store.get(draftKey))).pending).toBeUndefined()
    expect(await idb('readonly',store=>store.get('project_1:draft2-rejected:lineage-one'))).toEqual({submissionId:'invalid-old',body})
    code=200;click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
    expect(JSON.parse(bodies[2])).toMatchObject({contributor:{name:'Alice'},edits:[{afterMarkdown:'corrected live'}]})
    expect(JSON.parse(bodies[2]).submissionId).not.toBe('invalid-old')
  })

  it.each([
    ['new target / old target',17], ['prefix old target',11],
  ])('final fix I2: maps submitted selector with owner anchor after %s',async(after,start)=> {
    const fixture=draftFixture();fixture.base['README.md'].markdown='old target';fixture.after['README.md']=after
    const note={path:'README.md',selector:{exact:'target',start:4,end:10,prefix:'old ',suffix:''},comment:'original target'}
    await idb('readwrite',store=>store.put(fixture,draftKey))
    await idb('readwrite',store=>store.put([note],'project_1:draft2-notes:lineage-one'))
    const bodies:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST')bodies.push(init.body);return Response.json({})}))
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
    const payload=JSON.parse(bodies[0]);expect(payload.annotations[0].selector.start).toBe(start)
    expect(anchor(payload.edits[0].afterMarkdown,payload.annotations[0].selector)).toMatchObject({status:'exact',start,end:start+6})
    expect(await idb('readonly',store=>store.get('project_1:draft2-notes:lineage-one'))).toEqual([note])
    click('submit');await vi.waitFor(()=>expect(status()).toContain('没有新的修改'));expect(bodies).toHaveLength(1)
    click('edit');input('again '+after);click('submit');await vi.waitFor(()=>expect(bodies).toHaveLength(2));await vi.waitFor(()=>expect(status()).toContain('已送达'))
    const next=JSON.parse(bodies[1]);expect(next.supersedes).toBe(payload.submissionId)
    expect(anchor(next.edits[0].afterMarkdown,next.annotations[0].selector)).toMatchObject({start:start+6})
  })

  it.each(['old target / old target','replacement without quote'])('final fix I2: retains unresolved notes and allows explicit removal (%s)',async after=> {
    const fixture=draftFixture();fixture.base['README.md'].markdown='old target';fixture.after['README.md']=after
    const note={path:'README.md',selector:{exact:'target',start:4,end:10,prefix:'old ',suffix:''},comment:'keep me'}
    await idb('readwrite',store=>store.put(fixture,draftKey))
    await idb('readwrite',store=>store.put([note],'project_1:draft2-notes:lineage-one'))
    const send=vi.fn(async()=>Response.json({}));vi.stubGlobal('fetch',send)
    await serialized();click('submit');await vi.waitFor(()=>expect(($('submit') as HTMLButtonElement).disabled).toBe(false))
    expect(send).not.toHaveBeenCalled();expect(status()).toContain('批注');expect(status()).toContain('移除')
    expect(await idb('readonly',store=>store.get('project_1:draft2-notes:lineage-one'))).toEqual([note])
    $('comments').querySelector<HTMLButtonElement>('button')!.click();click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
  })

  it('final fix I2: migrates v1 anchors into actual v2 wire text and keeps the sent hash stable on reload',async()=> {
    const data=JSON.parse($('project-data').textContent!);data.snapshot.files[0].markdown='old target';$('project-data').textContent=JSON.stringify(data)
    await idb('readwrite',store=>store.put({drafts:{'README.md':'new target / old target'},annotations:[{path:'README.md',quote:'target',start:4,end:10,comment:'legacy'}]},'project_1:snapshot_1'))
    const bodies:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{if(init?.method==='POST')bodies.push(init.body);return Response.json({})}))
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('已送达'))
    const sent=JSON.parse(bodies[0]);expect(anchor(sent.edits[0].afterMarkdown,sent.annotations[0].selector)).toMatchObject({start:17})
    const html=buildProjectBundle({...snapshot,files:data.snapshot.files},'https://share.test/feedback/project_1')
    document.body.innerHTML=html.slice(html.indexOf('<body>')+6,html.indexOf('</body>'))
    const restored=JSON.parse($('project-data').textContent!);delete restored.versionUrl;$('project-data').textContent=JSON.stringify(restored)
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('没有新的修改'));expect(bodies).toHaveLength(1)
  })

  const protocolFixtures=Object.entries(import.meta.glob('../../../src-tauri/tests/fixtures/project-feedback/{valid,invalid}/*.json',{eager:true,query:'?raw',import:'default'}) as Record<string,string>)
    .filter(([,body])=>JSON.parse(body).schemaVersion===2)
    .map(([path,body])=>({name:path.split('/').pop(),body,invalid:path.includes('/invalid/')}))
  it.each(protocolFixtures)('final fix I1: frozen strict validation matches shared fixture $name',async({body,invalid})=> {
    await idb('readwrite',store=>store.put({...draftFixture(),pending:{submissionId:JSON.parse(body).submissionId,body}},draftKey))
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:400})))
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('400'))
    expect(($('correct-rejected') as HTMLButtonElement).hidden).toBe(!invalid)
    expect((await idb('readonly',store=>store.get(draftKey))).pending.body).toBe(body)
  })

  it('final fix I1: retirement preserves input during its durable transaction and exposes original bytes in export',async()=> {
    const body=JSON.stringify({schemaVersion:2,project_id:'project_1',snapshotId:'snapshot-old',submissionId:'bad',message:'x'.repeat(2001),edits:[],annotations:[]})
    await idb('readwrite',store=>store.put({...draftFixture(),pending:{submissionId:'bad',body}},draftKey))
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:400})))
    await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('400'));click('edit')
    const put=FakeObjectStore.prototype.put
    const spy=vi.spyOn(FakeObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){
      const op=put.call(this,value,key)
      if(key==='project_1:draft2-rejected:lineage-one') queueMicrotask(()=>input('during retirement'))
      return op
    })
    try {
      click('correct-rejected');await vi.waitFor(()=>expect(status()).toContain('已解除冻结'))
      await vi.waitFor(async()=>expect((await idb('readonly',store=>store.get(draftKey))).after['README.md']).toBe('during retirement'))
      expect((await idb('readonly',store=>store.get(draftKey))).pending).toBeUndefined()
    } finally {spy.mockRestore()}
    let blob:Blob|undefined
    const url=vi.spyOn(URL,'createObjectURL').mockImplementation(value=>{blob=value as Blob;return 'blob:test'})
    const save=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{})
    try {click('export');expect(JSON.parse(await blob!.text()).rejected).toEqual([['lineage-one',{submissionId:'bad',body}]])} finally {url.mockRestore();save.mockRestore()}
  })

  it.each([['x'.repeat(2001),'note','选文'],['target','x'.repeat(10001),'评论']])('final fix I1: rejects oversized form annotation before saving (%s)',async(quote,comment,label)=> {
    const data=JSON.parse($('project-data').textContent!);data.snapshot.files[0].markdown=quote;$('project-data').textContent=JSON.stringify(data)
    vi.stubGlobal('prompt',()=>comment);await serialized()
    const range=document.createRange();range.selectNodeContents($('document').querySelector('p')!);window.getSelection()!.removeAllRanges();window.getSelection()!.addRange(range)
    click('annotate');expect(status()).toContain(label);expect($('comments').children).toHaveLength(0)
  })

  it('final fix I1: failed retirement transaction leaves both pending and its prior rejection copy intact',async()=> {
    const body=JSON.stringify({schemaVersion:2,project_id:'project_1',snapshotId:'snapshot-old',submissionId:'bad',message:'x'.repeat(2001),edits:[],annotations:[]})
    const previous={submissionId:'previous',body:'previous original bytes'}
    await idb('readwrite',store=>store.put({...draftFixture(),pending:{submissionId:'bad',body}},draftKey))
    await idb('readwrite',store=>store.put(previous,'project_1:draft2-rejected:lineage-one'))
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:400})));await serialized();click('submit');await vi.waitFor(()=>expect(status()).toContain('400'))
    const put=FakeObjectStore.prototype.put
    const spy=vi.spyOn(FakeObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,value,key){const op=put.call(this,value,key);if(key==='project_1:draft2-rejected:lineage-one')this.transaction.abort();return op})
    try {
      click('correct-rejected');await vi.waitFor(()=>expect(status()).toContain('纠正未保存'))
      expect((await idb('readonly',store=>store.get(draftKey))).pending.body).toBe(body)
      expect(await idb('readonly',store=>store.get('project_1:draft2-rejected:lineage-one'))).toEqual(previous)
    } finally {spy.mockRestore()}
  })

})

describe('enhanced reader compatibility boundaries',()=> {
  it('keeps enhanced Critic raw and blocks fallback submission until the editor is restored',async()=> {
    const raw='{==原始内容==}{>>访客批注<<}'
    values.set('project_1:draft2:enhanced',{v:2,lineageId:'enhanced',snapshotId:'snapshot_1',base:{'README.md':{hash:'a'.repeat(64),markdown:snapshot.files[0].markdown}},after:{'README.md':raw},annotationKinds:{},editorFiles:{'README.md':{v:1}}})
    const send=vi.fn();vi.stubGlobal('fetch',send)
    await serialized();click('submit')
    await vi.waitFor(()=>expect(status()).toContain('请恢复增强编辑器或导出备份'))
    expect(send).not.toHaveBeenCalled();expect(values.get('project_1:draft2:enhanced').after['README.md']).toBe(raw)
    click('edit');input(raw+' 后续')
    await vi.waitFor(()=>expect(values.get('project_1:draft2:enhanced').after['README.md']).toBe(raw+' 后续'))
    click('submit');await vi.waitFor(()=>expect(($('submit') as HTMLButtonElement).disabled).toBe(false))
    expect(status()).toContain('请恢复增强编辑器或导出备份');expect(send).not.toHaveBeenCalled()
  })
  it.each([[404,'已送达，待处理'],[403,'权限不足'],[410,'分享已失效']])('shows receipt HTTP %i as plain text %s',async(code,label)=> {
    values.set('project_1:submitted',['receipt-one'])
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:code as number})))
    await projectShareBrowser(new Marked())
    await vi.waitFor(()=>expect($('receipts').textContent).toContain(label))
  })
  it('defaults AI off and derives fallback tree badges and filter from the same draft',async()=> {
    await projectShareBrowser(new Marked());click('edit');input('a changed file')
    await vi.waitFor(()=>expect(document.querySelector('[data-file="README.md"] .file-badge')?.textContent).toContain('●'))
    expect(($('ai-assisted') as HTMLInputElement).checked).toBe(false)
    ;($('changed-only') as HTMLInputElement).checked=true;$('changed-only').dispatchEvent(new Event('change'))
    expect(document.querySelectorAll('[data-file]')).toHaveLength(1)
  })
})

describe('serialized fallback Critic multiset guard',()=> {
  it.each([false,true])('preserves original owner notes while ordinary editing; duplicate=%s',async(duplicate)=> {
    const owner='{==owner==}{>>原注<<}', base=owner+'\n\nA', raw=owner+(duplicate?owner:'')+'\n\nB'
    values.set('project_1:draft2:owner-plain',{v:2,lineageId:'owner-plain',snapshotId:'snapshot_1',base:{'README.md':{hash:'a'.repeat(64),markdown:base}},after:{'README.md':raw},annotationKinds:{}})
    const bodies:string[]=[];vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{bodies.push(init.body);return Response.json({})}))
    await serialized();click('submit');await vi.waitFor(()=>expect(($('submit') as HTMLButtonElement).disabled).toBe(false))
    if(duplicate) {expect(bodies).toHaveLength(0);expect(status()).toContain('请恢复增强编辑器或导出备份')}
    else {expect(bodies).toHaveLength(1);expect(JSON.parse(bodies[0]).edits[0].afterMarkdown).toBe(raw)}
  })
})
