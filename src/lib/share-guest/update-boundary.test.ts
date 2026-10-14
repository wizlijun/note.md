// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mocked = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocked.invoke }))
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({ get: async () => ({ token: 'synthetic' }) }) } }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: (p: string) => readFile(p, 'utf8'), writeTextFile: (p: string, s: string) => writeFile(p, s), stat: (p: string) => stat(p) }))
vi.mock('../settings.svelte', () => ({ settings: { mdblock: {enabled:false} }, pushRecentFile: async () => {}, getRecentMode: () => null, setRecentMode: async () => {} }))
vi.mock('../plugins/custom-editors', () => ({ customEditorFor: () => null }))
vi.mock('../plugins/runtime.svelte', () => ({ pluginRuntime: { manifests: [] } }))
vi.mock('../file-watcher.svelte', () => ({ startWatchingTab: async () => {}, stopWatchingTab: async () => {}, rebindTabPath: async () => {} }))
vi.mock('../mdblock/auto-refresh', () => ({ maybeAutoRefresh: async () => {} }))
vi.mock('../platform.svelte', () => ({ platform: async () => 'macos' }))
vi.mock('../sotvault.svelte', () => ({ sourceForVaultPath: () => null, maybeCheckVaultUpdate: async () => {}, pushSourceToVaultIfTracked: async () => {} }))
vi.mock('../outline/migrate', () => ({ migrateLegacyCompanion: async () => {} }))
vi.mock('../insights/tracker.svelte', () => ({ onActiveDocChanged: () => {} }))
vi.mock('@tauri-apps/plugin-os',()=>({platform:()=> 'macos',type:()=> 'macos'}))
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}))
import { mount, unmount, tick } from 'svelte'
import { BrowserMediaResolver } from '@moraya/core/adapters/browser-media-resolver'
import { mountFileEditor } from '../../editor-kit-v2/file-main'
import { registerFileEditorSession, closeFileEditorSession, captureFileSave } from '../file-editor-sessions'
import { tabs, activeId, withGuestFileUpdate, persistMarkdownSnapshot, markdownWriteEpoch, isReadOnlyTab, isGuestUpdateBusy, saveTab } from '../tabs.svelte'
import { sha256Sync } from '../share-merge/hash'
import SourceHarness from './UpdateSourceHarness.svelte'
import {noteUi} from '../note-anno/note-ui.svelte'
async function fixture(raw='A\r\n',name='a.md') {
 const root=await mkdtemp(join(tmpdir(),'guest-update-owner-')),path=join(root,name);await writeFile(path,raw)
 tabs.push({id:crypto.randomUUID(),filePath:path,title:'a.md',kind:'markdown',mode:'source',currentContent:raw,initialContent:raw,externalState:'fresh',externalBannerDismissed:false,lastKnownHash:sha256Sync(raw),lastKnownMtime:0})
 const tab=tabs[tabs.length-1];activeId.value=tab.id
 const session=await mountFileEditor(document.body,{file:{documentId:path,authority:'old',raw},adapters:{mediaResolver:new BrowserMediaResolver()}},{externalSource:true,styles:'host'})
 registerFileEditorSession(tab.id,session)
 const off=session.owner.observe(snapshot=>{tab.currentContent=snapshot.raw})
 const component=mount(SourceHarness,{target:document.body,props:{tab,session}});await tick()
 const textarea=document.querySelector<HTMLTextAreaElement>('.source-view textarea')??document.querySelector<HTMLTextAreaElement>('textarea')!
 const type=(text:string)=>{textarea.value=text;textarea.dispatchEvent(new Event('input',{bubbles:true}))}
 return {root,path,tab,session,textarea,type,async close(){noteUi.edit=null;await unmount(component);off();await closeFileEditorSession(tab.id);tabs.length=0;activeId.value=null;document.body.replaceChildren();await rm(root,{recursive:true,force:true})}}
}
it('real Source input is saved exactly, stale save snapshots cannot cross CAS, and baseline/history reload',async()=>{
 const f=await fixture();try {
  f.type('AB\n');await tick();const oldEpoch=markdownWriteEpoch(f.path),oldReceipt=captureFileSave(f.tab.id,f.tab.currentContent)
  const oldIdentity=f.session.baselineIdentity
  await withGuestFileUpdate([f.path],async check=>{
   expect(await readFile(f.path,'utf8')).toBe('AB\r\n');expect(f.textarea.readOnly).toBe(true);expect(isReadOnlyTab(f.tab)).toBe(true)
   expect(f.session.owner.restoreContent('forbidden').ok).toBe(false)
   await saveTab(f.tab.id);await check();await writeFile(f.path,'S2\r\n')
   return {value:true,writes:{[f.path]:sha256Sync('S2\r\n')}}
  })
  expect(f.tab.currentContent).toBe('S2\r\n');expect(f.session.owner.snapshot().raw).toBe('S2\r\n');expect(f.session.baselineIdentity).not.toBe(oldIdentity);expect(f.session.owner.canUndo()).toBe(false)
  await persistMarkdownSnapshot(f.tab,'AB\r\n',false,f.path,oldReceipt,oldEpoch)
  expect(await readFile(f.path,'utf8')).toBe('S2\r\n');await tick();expect(f.textarea.readOnly).toBe(false)
  f.type('S2 next\n');await tick();await saveTab(f.tab.id);expect(await readFile(f.path,'utf8')).toBe('S2 next\r\n')
 } finally {await f.close()}
})
it('synthetic external Source composition keeps input and performs zero CAS until composition finishes',async()=>{
 const f=await fixture();try {
  f.textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));f.type('拼音\n')
  let called=false
  const operation=withGuestFileUpdate([f.path],async()=>{called=true;return{value:true,writes:{}}})
  await tick();await Promise.resolve();expect(called).toBe(false);expect(f.textarea.value).toBe('拼音\n')
  f.textarea.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'拼音'}));await operation
  expect(await readFile(f.path,'utf8')).toBe('拼音\r\n');expect(f.session.owner.snapshot().raw).toBe('拼音\r\n')
 } finally {await f.close()}
})
it('a pending annotation popup blocks CAS and releases only temporary capability',async()=>{
 const f=await fixture('{>>old<<}\n');try {
  f.session.annotations.editAt(1);expect(noteUi.edit).toBeTruthy();noteUi.edit!.flushDraft=()=>false
  const cas=vi.fn(async()=>({value:true,writes:{}}))
  await expect(withGuestFileUpdate([f.path],cas)).rejects.toThrow('annotation-pending');expect(cas).not.toHaveBeenCalled();expect(isGuestUpdateBusy(f.path)).toBe(false);expect(noteUi.edit).toBeTruthy();expect(await readFile(f.path,'utf8')).toBe('{>>old<<}\n')
  noteUi.edit=null;expect(f.session.owner.restoreContent('after').ok).toBe(true)
 } finally {await f.close()}
})
it.each(['external','install','tab'] as const)('reload failure %s preserves accepted draft and exposes disk recovery without compensating write',async(reason)=>{
 const f=await fixture();try {
  f.type('my input\n');await tick()
  const original=f.session.owner.installBaseline
  await expect(withGuestFileUpdate([f.path],async()=>{
   await writeFile(f.path,'S2\r\n')
   if(reason==='external')await writeFile(f.path,'external\r\n')
   if(reason==='install')f.session.owner.installBaseline=()=>({ok:false,reason:'injected install failure'})
   if(reason==='tab')f.tab.filePath=join(f.root,'renamed.md')
   return{value:true,writes:{[f.path]:sha256Sync('S2\r\n')}}
  })).rejects.toThrow()
  f.session.owner.installBaseline=original
  expect(f.session.owner.snapshot().raw).toBe('my input\r\n');expect(f.tab.currentContent).toBe('my input\r\n');expect(f.tab.guestUpdateRecovery).toEqual({path:f.path,content:'my input\r\n'});expect(f.tab.pendingExternal?.content).toBe(reason==='tab'?undefined:reason==='external'?'external\r\n':'S2\r\n')
  expect(await readFile(f.path,'utf8')).toBe(reason==='external'?'external\r\n':'S2\r\n');expect(isGuestUpdateBusy(f.path)).toBe(false);expect(f.session.owner.restoreContent('recoverable').ok).toBe(true)
 } finally {await f.close()}
})
it('unknown open draft is frozen without being saved or installed',async()=>{
 const f=await fixture();try {
  f.type('unknown unsaved\n');await tick()
  await withGuestFileUpdate([],async()=>{expect(f.textarea.readOnly).toBe(true);expect(await readFile(f.path,'utf8')).toBe('A\r\n');return{value:true,writes:{}}},{root:f.root,managedPaths:[]})
  expect(await readFile(f.path,'utf8')).toBe('A\r\n');expect(f.session.owner.snapshot().raw).toBe('unknown unsaved\r\n')
 }finally{await f.close()}
})
it('legacy MDX Source has real composition admission and restores its original write capability',async()=>{
 const root=await mkdtemp(join(tmpdir(),'guest-mdx-')),path=join(root,'a.mdx');await writeFile(path,'<Widget />\n')
 tabs.push({id:'mdx-source',filePath:path,title:'a.mdx',kind:'mdx',mode:'source',currentContent:'<Widget />\n',initialContent:'<Widget />\n',externalState:'fresh',externalBannerDismissed:false,lastKnownHash:'',lastKnownMtime:0})
 const tab=tabs[tabs.length-1],component=mount(SourceHarness,{target:document.body,props:{tab}});activeId.value=tab.id;await tick();const textarea=document.querySelector('textarea')!
 try {
  textarea.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));textarea.value='<Widget text="中" />\n';textarea.dispatchEvent(new Event('input',{bubbles:true}))
  const cas=vi.fn(async()=>({value:true,writes:{}}));await expect(withGuestFileUpdate([path],cas)).rejects.toThrow('GUEST_INPUT_PENDING');expect(cas).not.toHaveBeenCalled();expect(textarea.value).toContain('中')
  textarea.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));
  await withGuestFileUpdate([path],async()=>{expect(textarea.readOnly).toBe(true);expect(await readFile(path,'utf8')).toContain('中');await writeFile(path,'<Updated />\n');return{value:true,writes:{[path]:sha256Sync('<Updated />\n')}}})
  await tick();expect(textarea.readOnly).toBe(false);expect(tab.currentContent).toBe('<Updated />\n')
 }finally{await unmount(component);tabs.length=0;activeId.value=null;document.body.replaceChildren();await rm(root,{recursive:true,force:true})}
})
it('a queued real autosave timer is cancelled across the update window',async()=>{
 const f=await fixture();const {settings}=await import('../settings.svelte'),{startAutoSaveWatcher}=await import('../autosave.svelte')
 settings.autoSave=true
 const stop=startAutoSaveWatcher()
 try {
  f.type('before timer\n');await tick()
  await withGuestFileUpdate([f.path],async()=>{await writeFile(f.path,'S2\r\n');return{value:true,writes:{[f.path]:sha256Sync('S2\r\n')}}})
  await new Promise(resolve=>setTimeout(resolve,850));expect(await readFile(f.path,'utf8')).toBe('S2\r\n')
  f.type('after update\n');await tick();await new Promise(resolve=>setTimeout(resolve,850));expect(await readFile(f.path,'utf8')).toBe('after update\r\n')
 }finally{stop();settings.autoSave=false;await f.close()}
})
it.each(['ours','theirs','edited'] as const)('real GuestPanel → save queue → planner → %s decision → baseline installation',async(choice)=>{
 const f=await fixture('A\r\n'),{default:GuestPanel}=await import('../../components/share-guest/GuestPanel.svelte'),{guestState}=await import('./state.svelte'),{t}=await import('../i18n/store.svelte')
 let info:any={schemaVersion:1,root:f.root,entry:'a.md',origin:'https://share.example',slug:'2026-10-14-test',shareUrl:'https://share.example/2026-10-14-test',project_id:'pid',snapshotId:'S1',files:[{path:'a.md',hash:sha256Sync('A\r\n')}],submitted:['previous'],lastSubmissionId:'previous',outbox:[],pendingUpdate:null}
 let rows:any[]=[],release:(()=>void)|undefined
 const order:string[]=[]
 mocked.invoke.mockImplementation(async(_,{request:r}:any)=>{
  order.push(r.op)
  if(r.op==='check-version')return{changed:info.snapshotId==='S1'}
  if(r.op==='inspect')return structuredClone(info)
  if(r.op==='update-prepare'){
   if(!info.pendingUpdate) {await new Promise<void>(resolve=>{release=resolve});info.pendingUpdate={snapshotId:'S2',paths:['a.md'],unresolved:[]}}
   return structuredClone(info)
  }
  if(r.op==='update-read') {expect(isGuestUpdateBusy(f.path)).toBe(true);const raw=await readFile(f.path,'utf8');return{fromSnapshotId:'S1',toSnapshotId:'S2',oldBase:{'a.md':'A\r\n'},newBase:{'a.md':'B\r\n'},oldFiles:{'a.md':sha256Sync('A\r\n')},newFiles:{'a.md':sha256Sync('B\r\n')},work:{'a.md':raw},workHashes:{'a.md':sha256Sync(raw)},occupied:['a.md'],journal:rows.length>0}}
  if(r.op==='update-apply') {expect(r.plan.actions).toEqual([]);expect(r.plan.conflicts).toHaveLength(1);expect(await readFile(f.path,'utf8')).toBe('C\r\n');rows=r.plan.conflicts.map((c:any)=>({sourcePath:c.path,path:c.path,expectedHash:c.expectedHash,resultHash:null,action:'conflict',state:'waiting'}));info.pendingUpdate.unresolved=['a.md'];return structuredClone(info)}
  if(r.op==='resolve') {expect(r.expectedHash).toBe(sha256Sync(await readFile(f.path,'utf8')));await writeFile(f.path,r.content);rows[0]={...rows[0],state:'done',resultHash:sha256Sync(r.content)};info.pendingUpdate.unresolved=[];return structuredClone(info)}
  if(r.op==='update-status')return{info:structuredClone(info),rows:await Promise.all(rows.map(async row=>({...row,currentHash:sha256Sync(await readFile(f.path,'utf8'))})))}
  if(r.op==='update-finish'){info={...info,snapshotId:'S2',files:[{path:'a.md',hash:sha256Sync('B\r\n')}],pendingUpdate:null};return structuredClone(info)}
  throw Error('unexpected op '+r.op)
 })
 guestState.projects=[structuredClone(info)]
 const component=mount(GuestPanel,{target:document.body,props:{tab:f.tab}})
 const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('.guest-panel button')].find(b=>b.textContent?.trim()===label)!
 try {
  await tick();button(t('guest.update')).click();await vi.waitFor(()=>expect(release).toBeDefined())
  expect(isGuestUpdateBusy(f.path)).toBe(false);f.type('C\n');await tick();release!()
  await vi.waitFor(()=>expect(button(t('guest.myVersion'))).toBeTruthy());expect(f.session.owner.snapshot().raw).toBe('C\r\n')
  if(choice==='edited'){const edit=document.querySelector<HTMLTextAreaElement>('.conflict-editor textarea')!;edit.value='Human\r\n';edit.dispatchEvent(new Event('input',{bubbles:true}));await tick()}
  button(t(choice==='ours'?'guest.publisherVersion':choice==='theirs'?'guest.myVersion':'guest.useEdited')).click();await tick();button(t('guest.resolve')).click()
  const expected=choice==='ours'?'B\r\n':choice==='theirs'?'C\r\n':'Human\r\n'
  await vi.waitFor(()=>expect(guestState.projects[0].snapshotId).toBe('S2'))
  expect(f.session.owner.snapshot().raw).toBe(expected);expect(await readFile(f.path,'utf8')).toBe(expected);expect(f.session.owner.canUndo()).toBe(false)
  expect(order.filter(op=>op==='update-apply')).toHaveLength(1);expect(order.filter(op=>op==='resolve')).toHaveLength(1);expect(order).not.toContain('apply');expect(order).not.toContain('queue')
 }finally{await unmount(component);guestState.projects=[];await f.close()}
})
it.each([false,true])('real annotation popup is frozen and late synthetic pending input blocks CAS: %s',async(late)=>{
 const f=await fixture('{>>old<<}\n'),{default:Popup}=await import('../note-anno/NoteEditPopup.svelte')
 f.session.annotations.editAt(1);const popup=mount(Popup,{target:document.body});await tick();const textarea=document.querySelector<HTMLTextAreaElement>('.note-edit-popup textarea, .note-edit textarea')!
 try {
  textarea.value='saved';textarea.dispatchEvent(new Event('input',{bubbles:true}));let cas=0
  const update=withGuestFileUpdate([f.path],async check=>{
   expect(textarea.readOnly).toBe(true);expect(await readFile(f.path,'utf8')).toBe('{>>saved<<}\n')
   if(late){textarea.value='late pending';textarea.dispatchEvent(new Event('input',{bubbles:true}))}
   await check();cas++;return{value:true,writes:{}}
  })
  if(late){await expect(update).rejects.toThrow('annotation-pending');expect(cas).toBe(0);expect(textarea.value).toBe('late pending');expect(f.session.owner.snapshot().raw).toBe('{>>saved<<}\n');await tick();expect(textarea.readOnly).toBe(false)}
  else{await update;expect(cas).toBe(1)}
 }finally{noteUi.edit=null;await unmount(popup);await f.close()}
})
it('dirty external disk changes are preserved before preparation save and zero CAS',async()=>{
 const f=await fixture();try {
  f.type('my draft\n');await tick();await writeFile(f.path,'external\r\n');const cas=vi.fn(async()=>({value:true,writes:{}}))
  await expect(withGuestFileUpdate([f.path],cas)).rejects.toThrow('GUEST_WORK_CHANGED');expect(cas).not.toHaveBeenCalled();expect(await readFile(f.path,'utf8')).toBe('external\r\n');expect(f.session.owner.snapshot().raw).toBe('my draft\r\n')
 }finally{await f.close()}
})
it('a clean tab never writes its stale baseline over the current work before capture',async()=>{
 const f=await fixture();try {
  await writeFile(f.path,'external\r\n')
  await withGuestFileUpdate([f.path],async()=>{expect(await readFile(f.path,'utf8')).toBe('external\r\n');return{value:true,writes:{[f.path]:sha256Sync('external\r\n')}}})
  expect(f.session.owner.snapshot().raw).toBe('external\r\n')
 }finally{await f.close()}
})
it('host collision selection preserves an open unsaved shared target that does not exist on disk',async()=>{
 const f=await fixture('open draft\n','a.shared.md'),{updateGuest}=await import('./host')
 await rm(f.path);await writeFile(join(f.root,'a.md'),'unknown original\n');f.type('still unsaved\n');await tick()
 let info:any={schemaVersion:1,root:f.root,snapshotId:'S1',files:[],outbox:[],pendingUpdate:{snapshotId:'S2',paths:['a.md'],unresolved:[]}},rows:any[]=[]
 mocked.invoke.mockImplementation(async(_,{request:r}:any)=>{
  if(r.op==='update-prepare')return structuredClone(info)
  if(r.op==='update-read')return{fromSnapshotId:'S1',toSnapshotId:'S2',oldBase:{},newBase:{'a.md':'published\n'},oldFiles:{},newFiles:{'a.md':sha256Sync('published\n')},work:{},workHashes:{},occupied:['a.md'],journal:false}
  if(r.op==='update-apply'){
   expect(f.textarea.readOnly).toBe(true)
   expect(r.plan.actions[0].path).toBe('a.shared-2.md');await writeFile(join(f.root,'a.shared-2.md'),'published\n')
   rows=[{sourcePath:'a.md',path:'a.shared-2.md',state:'done',action:'copy-base',resultHash:sha256Sync('published\n')}];return info
  }
  if(r.op==='update-status')return{info:structuredClone(info),rows}
  if(r.op==='update-finish')return info={...info,snapshotId:'S2',files:[{path:'a.md',hash:sha256Sync('published\n')}],workPaths:{'a.md':'a.shared-2.md'},pendingUpdate:null}
  throw Error('unexpected op '+r.op)
 })
 try {
  const result=await updateGuest(f.root);expect(result.info.workPaths).toEqual({'a.md':'a.shared-2.md'})
  await expect(readFile(f.path)).rejects.toThrow();expect(await readFile(join(f.root,'a.md'),'utf8')).toBe('unknown original\n')
  expect(await readFile(join(f.root,'a.shared-2.md'),'utf8')).toBe('published\n');expect(f.session.owner.snapshot().raw).toBe('still unsaved\n');await tick();expect(f.textarea.readOnly).toBe(false)
 }finally{await f.close()}
})
