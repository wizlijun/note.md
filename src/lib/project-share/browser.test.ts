// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Marked } from 'marked'
import { Zip, ZipPassThrough, Unzip, UnzipPassThrough, unzipSync } from 'fflate'
import { buildProjectBundle } from './bundle'
import { projectShareBrowser } from './browser'
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
  it('allows an oversized candidate to be reduced and freezes only a sendable packet', async () => {
    const send = vi.fn(async (_url: string, _init: RequestInit) => Response.json({}))
    vi.stubGlobal('fetch', send)
    await projectShareBrowser(new Marked())
    click('edit'); input('x'.repeat(5 * 1024 * 1024)); click('submit')
    expect(status()).toContain('超过 5 MiB')
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
    expect(values.get('project_1:snapshot_1').annotations).toEqual([{ path: 'README.md', quote: '方案', comment: '评论' }])
    expect(values.get('project_1:snapshot_1').drafts['README.md']).toBe('new draft')
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
