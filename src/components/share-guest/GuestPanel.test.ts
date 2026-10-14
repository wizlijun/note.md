// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocks=vi.hoisted(()=>({invoke:vi.fn(),get:vi.fn(),saveTab:vi.fn(),tabs:[] as any[],save:vi.fn(),write:vi.fn()}))
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}))
vi.mock('@tauri-apps/plugin-store',()=>({Store:{load:async()=>({get:mocks.get})}}))
vi.mock('@tauri-apps/plugin-dialog',()=>({save:mocks.save}))
vi.mock('@tauri-apps/plugin-fs',()=>({writeTextFile:mocks.write}))
vi.mock('../../lib/tabs.svelte',()=>({tabs:mocks.tabs,saveTab:mocks.saveTab,isReadOnlyTab:()=>false,openFile:vi.fn()}))
import GuestPanel from './GuestPanel.svelte'
import { guestState } from '../../lib/share-guest/state.svelte'
import { retryGuestOutbox } from '../../lib/share-guest/host'
import { shareEditor } from '../../share-editor/main'
import { sha256Sync } from '../../lib/share-merge/hash'
import type { DraftV2 } from '../../lib/project-share/types'
import type { GuestInfo } from '../../lib/share-guest/types'
const base='# Heading\r\n\r\nHello\r\n', after='# Heading\r\n\r\nHello world{>>guest comment<<}\r\n'
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(el=>el.textContent===text)!
afterEach(()=>{vi.clearAllMocks();mocks.tabs.length=0;document.body.replaceChildren();guestState.projects=[]})
it('real GuestPanel and real browser handle build equal wire structures; disk outbox replay survives restart and later drafts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'notemd-guest-')), metadata=join(dir,'guest.json'), working=join(dir,'a.md')
  const info:GuestInfo={schemaVersion:1,root:dir,entry:'a.md',origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test',project_id:'pid',snapshotId:'sid',files:[{path:'a.md',hash:sha256Sync(base)}],outbox:[],submitted:[],pendingUpdate:null}
  await writeFile(metadata,JSON.stringify(info));await writeFile(working,base)
  const tab={id:'tab',kind:'markdown',filePath:working,currentContent:after};mocks.tabs.push(tab);guestState.projects=[info];mocks.get.mockResolvedValue({token:'FIXTURE_TOKEN'})
  mocks.saveTab.mockImplementation(async()=>writeFile(working,tab.currentContent))
  const requests:string[]=[];let builds=0,queues=0
  mocks.invoke.mockImplementation(async(_cmd,{request:r})=>{
    const stored=JSON.parse(await readFile(metadata,'utf8'))
    if(r.op==='inspect') return stored
    if(r.op==='read-work') {builds++;return {info:stored,base:{'a.md':{markdown:base,hash:sha256Sync(base)}},after:{'a.md':await readFile(working,'utf8')},added:[],missing:[]}}
    if(r.op==='queue') {queues++;stored.outbox=[{submissionId:r.submissionId,body:r.body,queuedAt:'now'}];await writeFile(metadata,JSON.stringify(stored));return stored}
    if(r.op==='deliver') {requests.push(stored.outbox[0].body);throw Error('GUEST_HTTP_503')}
    if(r.op==='check-version') return {changed:false}
  })
  const desktop=mount(GuestPanel,{target:document.body,props:{tab:tab as any}})
  let browser:Awaited<ReturnType<typeof shareEditor.mount>>|undefined
  try {
    await vi.waitFor(()=>expect(button('Submit changes').disabled).toBe(false))
    const inputs=document.querySelectorAll('input');inputs[0].value='Visitor';inputs[0].dispatchEvent(new Event('input'))
    const message=document.querySelector('textarea')!;message.value='Review this';message.dispatchEvent(new Event('input'));await tick()
    button('Submit changes').click();button('Submit changes').click()
    await vi.waitFor(()=>expect(requests).toHaveLength(1))
    const persistedOutboxBody=JSON.parse(await readFile(metadata,'utf8')).outbox[0].body
    expect(requests[0]).toBe(persistedOutboxBody);expect(queues).toBe(1)
    const target=document.createElement('div');document.body.append(target)
    const draft:DraftV2={v:2,lineageId:'L',snapshotId:'sid',base:{'a.md':{markdown:base,hash:sha256Sync(base)}},after:{'a.md':after},annotationKinds:{}}
    browser=await shareEditor.mount(target,{apiVersion:1,theme:{themeId:'default'},snapshot:{project_id:'pid',snapshotId:'sid',entry:'a.md',files:[{path:'a.md',markdown:base,hash:sha256Sync(base)}]},loadDraft:async()=>draft,saveDraft:async d=>structuredClone(d),submit:vi.fn(),notify:vi.fn(),openFile:vi.fn(),setFileBadges:vi.fn()},{path:'a.md'})
    const browserBuilt=await browser.buildSubmission({message:'Review this',name:'Visitor'})
    const normalize=(body:string)=>{const {submissionId,client,...rest}=JSON.parse(body);return rest}
    expect(normalize(browserBuilt.body)).toEqual(normalize(persistedOutboxBody))
    expect(JSON.parse(persistedOutboxBody).client.kind).toBe('notemd')
    await unmount(desktop);tab.currentContent='later user draft';await writeFile(working,tab.currentContent)
    await expect(retryGuestOutbox(dir)).rejects.toThrow('503')
    expect(requests[1]).toBe(persistedOutboxBody);expect(builds).toBe(1);expect(queues).toBe(1)
    expect(await readFile(working,'utf8')).toBe('later user draft')
    // Producer bytes for the Rust owner-consumer acceptance gate; never includes credentials.
    if(process.env.GATE_LOG_DIR) await writeFile(join(process.env.GATE_LOG_DIR,'desktop-submission.json'),persistedOutboxBody)
  } finally { if(browser) await browser.destroy(); await rm(dir,{recursive:true,force:true}) }
})
it('without a credential, the panel permits local file use but never queues, delivers, or reads receipts',async()=>{
  const info={schemaVersion:1,root:'/received/pid',entry:'a.md',origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test',project_id:'pid',snapshotId:'sid',files:[{path:'a.md',hash:sha256Sync(base)}],outbox:[],submitted:['id'],pendingUpdate:null} as GuestInfo
  guestState.projects=[info];mocks.get.mockResolvedValue(undefined);mocks.invoke.mockResolvedValue({changed:false})
  const component=mount(GuestPanel,{target:document.body,props:{tab:{id:'t',filePath:info.root+'/a.md'} as any}})
  await tick();await new Promise(r=>setTimeout(r,0));expect(document.body.textContent).toContain('Changes are saved locally only')
  expect(button('Submit changes').disabled).toBe(true);expect(button('My submissions').disabled).toBe(true)
  expect(mocks.invoke.mock.calls.every(([,args])=>args.request.op==='check-version')).toBe(true);await unmount(component)
})
it('renders the actual P2 projection and unavailable receipt states as text without touching drafts',async()=>{
  const receipt=JSON.parse(await readFile(join(process.cwd(),'src-tauri/src/share_guest/fixtures/desktop-receipt.json'),'utf8'))
  const info:GuestInfo={schemaVersion:1,root:'/received/pid',entry:'a.md',origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test',project_id:'pid',snapshotId:'sid',files:[{path:'a.md',hash:sha256Sync(base)}],outbox:[],submitted:[receipt.submissionId],pendingUpdate:null}
  guestState.projects=[info];mocks.get.mockResolvedValue({token:'FIXTURE_TOKEN'})
  let status=200
  mocks.invoke.mockImplementation(async(_cmd,{request:r})=>r.op==='inspect'?info:r.op==='check-version'?{changed:false}:[{submissionId:receipt.submissionId,status,...(status===200?{receipt}:{})}])
  const component=mount(GuestPanel,{target:document.body,props:{tab:{id:'t',filePath:info.root+'/a.md'} as any}})
  await vi.waitFor(()=>expect(button('My submissions').disabled).toBe(false))
  button('My submissions').click();await vi.waitFor(()=>expect(document.body.textContent).toContain('Accepted 1/1'))
  receipt.reply='<img src="x" onerror="window.pwned=1">'
  button('My submissions').click();await vi.waitFor(()=>expect(document.body.textContent).toContain(receipt.reply))
  expect(document.querySelector('.receipt img')).toBeNull()
  for(const [code,label] of [[404,'awaiting review'],[403,'invalid credential'],[410,'expired'],[0,'result unknown']] as const) {
    status=code;button('My submissions').click();await vi.waitFor(()=>expect(document.body.textContent).toContain(label))
  }
  expect(mocks.invoke.mock.calls.some(([,args])=>['queue','deliver'].includes(args.request.op))).toBe(false)
  await unmount(component)
})
it('discards a receipt result after project identity changes while the request is pending',async()=>{
  const info:GuestInfo={schemaVersion:1,root:'/received/pid',entry:'a.md',origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test',project_id:'pid',snapshotId:'sid',files:[{path:'a.md',hash:sha256Sync(base)}],outbox:[],submitted:['old-submission'],pendingUpdate:null}
  guestState.projects=[info];mocks.get.mockResolvedValue({token:'FIXTURE_TOKEN'})
  let finish:((value:unknown)=>void)|undefined
  mocks.invoke.mockImplementation(async(_cmd,{request:r})=>r.op==='inspect'?info:r.op==='check-version'?{changed:false}:new Promise(resolve=>{finish=resolve}))
  const component=mount(GuestPanel,{target:document.body,props:{tab:{id:'t',filePath:info.root+'/a.md'} as any}})
  await vi.waitFor(()=>expect(button('My submissions').disabled).toBe(false));button('My submissions').click();await vi.waitFor(()=>expect(finish).toBeDefined())
  guestState.projects=[{...info,snapshotId:'new-sid'}];await tick()
  finish!([{submissionId:'old-submission',status:404}]);await tick();await new Promise(r=>setTimeout(r,0))
  expect(document.body.textContent).not.toContain('old-submission');await unmount(component)
})

it('clears the description across real A→B→A panel reuse and lists every shared Markdown extension',async()=>{
  const paths=['a.markdown','b.mdown','c.mkd','d.mdx','A.MD']
  const a={schemaVersion:1,root:'/received/a',entry:paths[0],origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test',project_id:'a',snapshotId:'sid',files:[...paths.map(path=>({path,hash:sha256Sync(base)})),{path:'image.png',hash:'image'}],outbox:[],submitted:[],pendingUpdate:null} as GuestInfo
  const b={...a,root:'/received/b',project_id:'b'}
  guestState.projects=[a,b];mocks.get.mockResolvedValue({token:'FIXTURE_TOKEN'});mocks.invoke.mockResolvedValue({changed:false})
  const {default:Harness}=await import('./GuestPanelTestHarness.svelte')
  const component=mount(Harness,{target:document.body,props:{a:a.root+'/'+paths[0],b:b.root+'/'+paths[0]}})
  try {
    await vi.waitFor(()=>expect(button('Submit changes').disabled).toBe(false))
    const field=document.querySelector('textarea')!;field.value='project A private explanation';field.dispatchEvent(new Event('input'));await tick()
    button('Go B').click();await tick()
    expect(document.querySelector('textarea')!.value).toBe('')
    button('Go A').click();await tick()
    expect(document.querySelector('textarea')!.value).toBe('')
    expect(Array.from(document.querySelectorAll('li button')).map(el=>el.textContent)).toEqual(paths)
  } finally {await unmount(component)}
})
it.each([[404,'not found'],[410,'expired']])('check-version %s shows the query status',async(status,label)=>{
  const info={schemaVersion:1,root:'/received/pid',entry:'a.md',origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test',project_id:'pid',snapshotId:'sid',files:[],outbox:[],submitted:[],pendingUpdate:null} as GuestInfo
  guestState.projects=[info];mocks.get.mockResolvedValue({token:'FIXTURE_TOKEN'});mocks.invoke.mockRejectedValue(Error('GUEST_HTTP_'+status))
  const component=mount(GuestPanel,{target:document.body,props:{tab:{id:'t',filePath:info.root+'/a.md'} as any}})
  try {await vi.waitFor(()=>expect(document.body.textContent).toContain(label));button('Check for updates').click();await vi.waitFor(()=>expect(document.body.textContent).toContain(label));expect(document.body.textContent).not.toContain('result unknown')} finally {await unmount(component)}
})
