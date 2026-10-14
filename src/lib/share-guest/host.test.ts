import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), load: vi.fn(), set: vi.fn(), save: vi.fn(), get: vi.fn(), saveTab: vi.fn(), tabs: [] as any[] }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: mocks.load } }))
vi.mock('../tabs.svelte', () => ({ tabs: mocks.tabs, saveTab: mocks.saveTab, isReadOnlyTab: () => false }))
import { guestCommand, saveGuestToken, submitGuest, retryGuestOutbox, buildDesktopSubmission } from './host'
import { parseGuestLink } from './link'
beforeEach(() => { vi.clearAllMocks(); mocks.load.mockResolvedValue({ set: mocks.set, save: mocks.save, get: mocks.get }); mocks.tabs.length = 0; mocks.get.mockResolvedValue({token:"FIXTURE_TOKEN"}) })
it('parsing the confirmation link never invokes or loads credentials', () => {
  parseGuestLink('https://host/2026-10-14-test#feedback=FIXTURE_TOKEN', false)
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled()
})
it('downloads with only the token-free identity, credentials stay in app-data Store', async () => {
  const { token, ...link } = parseGuestLink('https://host/2026-10-14-test#feedback=FIXTURE_TOKEN', false)
  await guestCommand('open', link)
  expect(mocks.invoke).toHaveBeenCalledWith('share_guest', { request: { op: 'open', ...link } })
  expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('FIXTURE_TOKEN')
  await saveGuestToken(link.origin, 'pid', token!)
  expect(mocks.load).toHaveBeenCalledWith('share_db.json')
  expect(mocks.set).toHaveBeenCalledWith('guest:https://host:pid', { token: 'FIXTURE_TOKEN' })
  expect(mocks.save).toHaveBeenCalledOnce()
})
it('rejects secret-bearing origin before opening the Store', async () => {
  await expect(saveGuestToken('https://user:FIXTURE_TOKEN@host', 'pid', 'FIXTURE_TOKEN')).rejects.toThrow('无效')
  expect(mocks.load).not.toHaveBeenCalled()
})

it('rejects an accidental full credential-bearing link before invoke', async () => {
  const link = parseGuestLink('https://host/2026-10-14-test#feedback=FIXTURE_TOKEN', false)
  await expect(guestCommand('open', { ...link })).rejects.toThrow('无效')
  expect(mocks.invoke).not.toHaveBeenCalled()
})

const info = {schemaVersion:1,root:'/vault/received/host/pid',entry:'a.md',origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test',project_id:'pid',snapshotId:'sid',files:[{path:'a.md',hash:''}],submitted:[],outbox:[],pendingUpdate:null}
import { sha256Sync } from '../share-merge/hash'
function setup() {
  const base='base\r\n', after='new\r\n'
  const fresh={...info,files:[{path:'a.md',hash:sha256Sync(base)}]}
  let persisted:any=fresh
  const order:string[]=[]
  mocks.tabs.push({id:'tab',kind:'markdown',filePath:info.root+'/a.md',currentContent:'STALE MEMORY'})
  mocks.saveTab.mockImplementation(async()=>{order.push('save')})
  mocks.invoke.mockImplementation(async(_cmd,{request:r})=>{
    order.push(r.op)
    if(r.op==='inspect') return structuredClone(persisted)
    if(r.op==='read-work') return {info:fresh,base:{'a.md':{markdown:base,hash:sha256Sync(base)}},after:{'a.md':after},added:[],missing:[]}
    if(r.op==='queue') {persisted={...persisted,outbox:[{submissionId:r.submissionId,body:r.body,queuedAt:'now'}]};return structuredClone(persisted)}
    if(r.op==='deliver') throw Error('GUEST_HTTP_503')
  })
  return {order,get persisted(){return persisted}}
}
it('flushes real saveTab boundary before reading disk; pure build never queues or sends',async()=>{
  const run=setup(), built=await buildDesktopSubmission(info.root,'tab','message','name')
  expect(run.order).toEqual(['inspect','save','read-work'])
  expect(JSON.parse(built.body).edits[0].afterMarkdown).toBe('new\r\n')
  expect(JSON.parse(built.body).client.kind).toBe('notemd')
})
it('locks duplicate submit, queues once, and retry never rebuilds/requeues even after editing',async()=>{
  const run=setup(), confirm=vi.fn(async()=>true)
  const first=submitGuest(info.root,'tab','message','name',confirm)
  expect(submitGuest(info.root,'tab','message','name',confirm)).toBe(first)
  await expect(first).rejects.toThrow('503')
  const body=run.persisted.outbox[0].body
  expect(run.order.filter(x=>x==='queue')).toHaveLength(1)
  expect(run.order.filter(x=>x==='deliver')).toHaveLength(1)
  run.order.length=0;mocks.tabs[0].currentContent='LATER EDIT'
  await expect(retryGuestOutbox(info.root)).rejects.toThrow('503')
  expect(run.order).toEqual(['inspect','deliver'])
  expect(run.persisted.outbox[0].body).toBe(body)
  expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('FIXTURE_TOKEN')
})
it('save failure or no credential stops before read-work/queue/deliver',async()=>{
  const run=setup();mocks.saveTab.mockRejectedValueOnce(Error('disk full'))
  await expect(submitGuest(info.root,'tab','','',async()=>true)).rejects.toThrow('disk full')
  expect(run.order).not.toContain('read-work');expect(run.order).not.toContain('queue')
  run.order.length=0;mocks.get.mockResolvedValue(undefined)
  await expect(submitGuest(info.root,'tab','','',async()=>true)).rejects.toThrow('GUEST_READ_ONLY')
  expect(run.order).toEqual(['inspect'])
})
it('requires explicit continuation for owner annotation edits and excludes added/missing files',async()=>{
  setup()
  const original=mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation(async(cmd,args)=>{
    if(args.request.op==='read-work') {
      const base='Text{>>owner<<}',after='Text{>>changed<<}'
      return {info,base:{'a.md':{markdown:base,hash:sha256Sync(base)}},after:{'a.md':after},added:['new.md'],missing:['lost.md']}
    }
    return original(cmd,args)
  })
  const confirm=vi.fn(async(_preview: import('./host').GuestPreview)=>false)
  await submitGuest(info.root,'tab','','',confirm)
  expect(confirm).toHaveBeenCalledOnce()
  expect(confirm.mock.calls[0]?.[0]).toMatchObject({added:['new.md'],missing:['lost.md'],ownerAnnotationsTouched:[{path:'a.md',raw:['{>>owner<<}']}]})
  expect(mocks.invoke.mock.calls.some(([,args])=>['queue','deliver'].includes(args.request.op))).toBe(false)
})
it('a failed durable queue stops delivery',async()=>{
  setup();const original=mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation((cmd,args)=>args.request.op==='queue'?Promise.reject(Error('disk full')):original(cmd,args))
  await expect(submitGuest(info.root,'tab','','',async()=>true)).rejects.toThrow('disk full')
  expect(mocks.invoke.mock.calls.some(([,args])=>args.request.op==='deliver')).toBe(false)
})
