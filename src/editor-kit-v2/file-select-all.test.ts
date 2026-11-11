/** @vitest-environment happy-dom */
import {afterEach,beforeAll,expect,it,vi} from 'vitest'
vi.mock('../lib/platform-sync',()=>({isApplePlatformSync:()=>true}))
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>null),convertFileSrc:(s:string)=>s}))
vi.mock('@tauri-apps/plugin-os',()=>({platform:()=> 'macos',type:()=> 'macos'}))
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}))
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver'
import {TextSelection} from 'prosemirror-state'
import {undoDepth} from 'prosemirror-history'
import {mount,unmount} from 'svelte'
import {applySelectAll} from '../lib/editor-select-all'
import {mountFileEditor,type FileMountSession} from './file-main'

// Compile the desktop component and its lazy plugins outside input assertions.
beforeAll(async()=>{
 await Promise.all([
  import('../components/RichEditor.svelte'), import('../lib/editor-bridge'),
  import('../lib/adapters/tauri-media-resolver'), import('../lib/wikilink-plugin'),
  import('../lib/note-anno/note-plugin'), import('../lib/placeholder-plugin'),
  import('../lib/note-anno/answer-card'), import('../lib/note-anno/adopt-answer'),
  import('../lib/power-mode/plugin'), import('../lib/power-mode/host-config.svelte'),
 ])
},30_000)
const editors:FileMountSession[]=[]
afterEach(async()=>{for(const f of editors.splice(0))await f.owner.close();document.body.replaceChildren();vi.restoreAllMocks()})
async function fixture(raw:string){
 const target=document.createElement('div');document.body.append(target)
 const changes:string[]=[],f=await mountFileEditor(target,{file:{documentId:'select-all.md',authority:'A',raw},adapters:{mediaResolver:new BrowserMediaResolver()},onChange:s=>changes.push(s.raw)},{styles:'host'});editors.push(f)
 return {f,changes}
}
function press(f:FileMountSession,key:string){
 const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})
 f.view.dom.dispatchEvent(event)
 return event
}
const metadata='---\ntitle: t\n---\n\n'
const body='A long paragraph with enough text to dominate the rendered metadata. '.repeat(12)+'\n\nSecond paragraph.\n'

it.each(['Backspace','Delete'])('actual rich %s deletes selected body, preserves metadata and supports save/undo/redo',async key=>{
 const raw=metadata+body,{f,changes}=await fixture(raw)
 applySelectAll(f.view)
 const selected=window.getSelection()!.toString()
 expect(selected.length).toBeGreaterThan(f.view.dom.textContent!.length*.9)
 expect(press(f,key).defaultPrevented).toBe(true)
 const changed=f.owner.snapshot().raw
 expect(changed).not.toBe(raw)
 expect(f.view.state.doc.firstChild!.type.name).toBe('frontmatter')
 expect(changed.startsWith(metadata)).toBe(true)
 expect(changed).not.toContain('A long paragraph')
 expect(changed).not.toContain('Second paragraph')
 expect(undoDepth(f.view.state)).toBe(1)
 await Promise.resolve();expect(changes).toEqual([changed])
 expect(await f.setMode('source')).toBe(true);expect((await f.owner.flush()).raw).toBe(changed);expect(await f.setMode('rich')).toBe(true)
 expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(raw)
 expect(f.owner.redo()).toBe(true);expect((await f.owner.flush()).raw).toBe(changed)
 const reopened=await fixture(changed);expect(reopened.f.owner.snapshot().raw).toBe(changed)
})

it.each(['Backspace','Delete'])('actual rich %s keeps unselected trailing text even when over 90 percent is selected',async key=>{
 const raw='x'.repeat(200)+'KEEP',{f}=await fixture(raw)
 f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc,1,201)))
 f.view.focus()
 expect(window.getSelection()!.toString().length).toBeGreaterThan(f.view.dom.textContent!.length*.9)
 press(f,key)
 expect(f.owner.snapshot().raw).toBe('KEEP')
 expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(raw)
})

it.each(['Backspace','Delete'])('actual rich %s still clears documents without metadata',async key=>{
 const raw='# Heading\n\n'+body,{f}=await fixture(raw)
 applySelectAll(f.view);press(f,key)
 expect(f.owner.snapshot().raw.trim()).toBe('')
 expect(f.view.state.doc.childCount).toBe(1);expect(f.view.state.doc.firstChild!.type.name).toBe('paragraph')
 expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(raw)
})

it('desktop Cmd+A then Backspace updates the actual file tab and preserves metadata',async()=>{
 const {default:RichEditor}=await import('../components/RichEditor.svelte'),{tabs,activeId}=await import('../lib/tabs.svelte'),{fileEditorSession,closeFileEditorSession}=await import('../lib/file-editor-sessions')
 const raw=metadata+body
 const tab={id:'select-all-desktop',filePath:'/vault/select-all.md',title:'select-all.md',kind:'markdown' as const,mode:'rich' as const,currentContent:raw,initialContent:raw,externalState:'fresh' as const,externalBannerDismissed:false,lastKnownMtime:0,lastKnownHash:''}
 tabs.push(tab);activeId.value=tab.id;let ready=false;const component=mount(RichEditor,{target:document.body,props:{tab:tabs.find(t=>t.id===tab.id)!,fileBacked:true,onFileReady:()=>{ready=true}}})
 try{
  await vi.waitFor(()=>expect(ready).toBe(true));const f=fileEditorSession(tab.id)!
  f.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key:'a',metaKey:true,bubbles:true,cancelable:true}))
  expect(f.view.state.selection.empty).toBe(false)
  expect(f.view.state.selection.from).toBeGreaterThanOrEqual(f.view.state.doc.firstChild!.nodeSize)
  press(f,'Backspace');const changed=(await f.owner.flush()).raw
  expect(changed).not.toBe(raw);expect(changed.startsWith(metadata)).toBe(true);expect(changed).not.toContain('A long paragraph')
  await vi.waitFor(()=>expect(tabs.find(t=>t.id===tab.id)!.currentContent).toBe(changed))
  expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(raw)
 }finally{await unmount(component);await closeFileEditorSession(tab.id);tabs.splice(0);activeId.value=null}
})

it.each(['Backspace','Delete'])('rich %s leaves readonly and composing documents unchanged',async key=>{
 const raw=metadata+body,{f,changes}=await fixture(raw)
 applySelectAll(f.view);f.owner.setReadOnly(true);press(f,key)
 expect(f.owner.snapshot().raw).toBe(raw)
 f.owner.setReadOnly(false)
 // Composition starts at a caret: ProseMirror intentionally replaces an
 // existing range on compositionstart before IME text is inserted.
 f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc,f.view.state.selection.from)))
 f.view.dom.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))
 try{
  f.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key,isComposing:true,bubbles:true,cancelable:true}))
  expect(f.owner.snapshot().raw).toBe(raw);expect(undoDepth(f.view.state)).toBe(0)
 }finally{f.view.dom.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))}
 await f.owner.flush();expect(changes).toEqual([])
})

const complexBodies = ['你好\n世界\n', '[r]: /target\n\n[链接][r]\n', '正文\n\n[r]: /target\n', '正文[^n]\n\n[^n]: 注释\n', '<div>HTML</div>\n', '$$\nx+y\n$$\n', '- 第一项\n  - 嵌套项\n']
it.each(complexBodies.flatMap(body => ['', metadata].flatMap(prefix => ['Backspace', 'Delete'].map(key => ({body, prefix, key})))))(
 'Rich $key clears selected complex body and survives reopen: $body (metadata: $prefix)', async ({body, prefix, key}) => {
  const raw=prefix+body,{f,changes}=await fixture(raw)
  applySelectAll(f.view)
  expect(f.view.state.selection.empty).toBe(false)
  expect(press(f,key).defaultPrevented).toBe(true)
  const changed=(await f.owner.flush()).raw
  expect(changed,String((f.baselineIdentity as {diagnostic:unknown}).diagnostic)).not.toBe(raw)
  if(prefix)expect(changed.startsWith(prefix.trimEnd()+'\n')).toBe(true)
  if(body.includes('[r]: /target'))expect(changed).toContain('[r]: /target')
  expect(f.view.state.doc.childCount).toBe(prefix?2:1)
  expect(f.view.state.doc.lastChild!.type.name).toBe('paragraph')
  expect(f.view.state.doc.lastChild!.content.size).toBe(0)
  await Promise.resolve();expect(changes).toEqual([changed])
  expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(raw)
  expect(f.owner.redo()).toBe(true);expect((await f.owner.flush()).raw).toBe(changed)
  expect(await f.setMode('source')).toBe(true);expect(await f.setMode('rich')).toBe(true)
  const reopened=await fixture(changed)
  expect(reopened.f.owner.snapshot().raw).toBe(changed)
  expect(reopened.f.view.state.doc.childCount).toBe(prefix?2:1)
  expect(reopened.f.view.state.doc.lastChild!.type.name).toBe('paragraph')
  expect(reopened.f.view.state.doc.lastChild!.content.size).toBe(0)
 })
