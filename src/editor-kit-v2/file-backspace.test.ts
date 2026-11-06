/** @vitest-environment happy-dom */
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('../lib/platform-sync',()=>({isApplePlatformSync:()=>true}))
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>null),convertFileSrc:(s:string)=>s}))
vi.mock('@tauri-apps/plugin-os',()=>({platform:()=> 'macos',type:()=> 'macos'}))
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}))
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver'
import {TextSelection} from 'prosemirror-state'
import {closeHistory} from 'prosemirror-history'
import {mount,unmount} from 'svelte'
import {mountFileEditor,type FileMountSession} from './file-main'
const editors:FileMountSession[]=[]
afterEach(async()=>{for(const f of editors.splice(0))await f.owner.close();document.body.replaceChildren()})
it.each(['前 **乙**','前 *乙*','前 ~~乙~~','前 ==乙==','前 `乙`','a b','甲 乙','# a b','- a b','abc','你好世界','---\ntitle: test\n---\n\n你好世界\n','# 标题\n\n你好世界\n','**你好世界**\n','- 你好世界\n','第一段\n\n第二段\n','[链接][id] 测试\n\n[id]: /url\n'])('rich caret Backspace deletes the preceding character: %j',async raw=>{
 const target=document.createElement('div');document.body.append(target)
 const f=await mountFileEditor(target,{file:{documentId:'backspace.md',authority:'A',raw},adapters:{mediaResolver:new BrowserMediaResolver()}},{styles:'host'});editors.push(f)
 let at=0;f.view.state.doc.descendants((node,pos)=>{if(node.isTextblock&&node.content.size)at=pos+1+node.content.size})
 f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc,at)));f.view.focus()
 const before=f.view.state.doc.textContent
 const event=new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true});f.view.dom.dispatchEvent(event)
 expect(event.defaultPrevented).toBe(true)
 expect(f.view.state.doc.textContent,String((f.baselineIdentity as {diagnostic:unknown}).diagnostic)).toBe(before.slice(0,-1))
 expect(f.owner.snapshot().raw).not.toBe(raw)
 const changed=f.owner.snapshot().raw
 expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(raw)
 expect(f.owner.redo()).toBe(true);expect((await f.owner.flush()).raw).toBe(changed)
})


it('desktop Rich input then repeated Backspace updates the file tab and preserves metadata',async()=>{
 const {default:RichEditor}=await import('../components/RichEditor.svelte')
 const {tabs,activeId}=await import('../lib/tabs.svelte')
 const {fileEditorSession,closeFileEditorSession}=await import('../lib/file-editor-sessions')
 const metadata='---\ntitle: backspace\n---\n\n',raw=metadata+'甲\n'
 const tab={id:'backspace-desktop',filePath:'/vault/backspace.md',title:'backspace.md',kind:'markdown' as const,mode:'rich' as const,currentContent:raw,initialContent:raw,externalState:'fresh' as const,externalBannerDismissed:false,lastKnownMtime:0,lastKnownHash:''}
 tabs.push(tab);activeId.value=tab.id
 let ready=false
 const component=mount(RichEditor,{target:document.body,props:{tab:tabs.find(t=>t.id===tab.id)!,fileBacked:true,onFileReady:()=>{ready=true}}})
 try{
  await vi.waitFor(()=>expect(ready).toBe(true))
  const f=fileEditorSession(tab.id)!,at=f.view.state.doc.content.size-1
  f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc,at)).insertText(' 乙'))
  expect(f.owner.snapshot().raw).toBe(metadata+'甲 乙\n')
  f.view.dispatch(closeHistory(f.view.state.tr));f.view.focus()
  for(const expected of ['甲 ','甲']){
   f.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}))
   expect(f.view.state.doc.lastChild!.textContent,String((f.baselineIdentity as {diagnostic:unknown}).diagnostic)).toBe(expected)
   const saved=await f.owner.flush()
   expect(saved.raw.startsWith(metadata)).toBe(true)
   await vi.waitFor(()=>expect(tabs.find(t=>t.id===tab.id)!.currentContent).toBe(saved.raw))
  }
  const changed=(await f.owner.flush()).raw
  expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(metadata+'甲 乙\n')
  expect(f.owner.redo()).toBe(true);expect((await f.owner.flush()).raw).toBe(changed)
  expect(await f.setMode('source')).toBe(true);expect((await f.owner.flush()).raw).toBe(changed)
  expect(await f.setMode('rich')).toBe(true);expect(f.view.state.doc.lastChild!.textContent).toBe('甲')
 }finally{await unmount(component);await closeFileEditorSession(tab.id);tabs.splice(0);activeId.value=null}
})
