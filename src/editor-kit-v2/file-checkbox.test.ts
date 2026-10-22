/** @vitest-environment happy-dom */
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>null),convertFileSrc:(s:string)=>s}))
vi.mock('@tauri-apps/plugin-os',()=>({platform:()=> 'macos',type:()=> 'macos'}))
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}))
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver'
import {closeHistory,undoDepth} from 'prosemirror-history'
import {mount,unmount} from 'svelte'
import {mountFileEditor,type FileMountSession} from './file-main'
const editors:FileMountSession[]=[]
afterEach(async()=>{for(const f of editors.splice(0))await f.owner.close();document.body.replaceChildren();vi.restoreAllMocks()})
async function fixture(raw:string,policy=()=>true){
 const target=document.createElement('div');document.body.append(target)
 const changes:string[]=[],f=await mountFileEditor(target,{file:{documentId:'task.md',authority:'A',raw},adapters:{mediaResolver:new BrowserMediaResolver()},policy:{acceptRawChange:(a,b)=>a===b||policy()},onChange:s=>changes.push(s.raw)},{styles:'host'});editors.push(f)
 return {f,changes}
}
// Only layout is stubbed: dispatch the DOM event through the installed core
// plugin, FileController, source admission, observers and native history.
function click(f:FileMountSession,index=0,clientX=6,button=0){
 const li=f.view.dom.querySelectorAll<HTMLElement>('li[data-item-type="task"]')[index]
 li.getBoundingClientRect=()=>({left:0,right:200,top:0,bottom:20,width:200,height:20}) as DOMRect
 const computed=window.getComputedStyle.bind(window)
 const style=vi.spyOn(window,'getComputedStyle').mockImplementation((el,pseudo)=>el===li?{paddingLeft:'24px'} as CSSStyleDeclaration:computed(el,pseudo))
 const coords=vi.spyOn(f.view,'posAtCoords').mockReturnValue(null)
 try{li.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button,clientX,clientY:10}))}finally{style.mockRestore();coords.mockRestore()}
}
const cases=[
 '- [ ] buy milk\n',
 '- [ ] A\n\n[^a]: note\n[^b]: note\n',
 '- [ ] buy milk\n\n[id]: https://example.com\n',
 '- [ ] [reference][id]\n\n[id]: https://example.com "title"\n',
 'Text[^note]\n\n- [ ] __中文。__\n  - nested detail\n\n[^note]: Evidence.\n',
 '- [ ] task\n\n  | A | B |\n  | - | - |\n  | C | D |\n',
 '\uFEFF> + [ ] __中文__ &amp; \\*\r\n>   continuation\r\n\r\n[id]: /target\r\n',
 '3) [ ] __ordered__\n4) ordinary\n',
 '- [ ]\n',
 '- [X] __already checked__\r\n',
]
it.each(cases)('actual checkbox preserves every other source byte, modes, save and undo/redo: %s',async raw=>{
 const {f,changes}=await fixture(raw),checked=/\[[xX]\]/.test(raw),changed=raw.replace(/\[[ xX]\]/,checked?'[ ]':'[x]'),bindings=f.owner.snapshot().bindings
 click(f);expect(f.owner.snapshot().raw).toBe(changed);expect(undoDepth(f.view.state)).toBe(1)
 await Promise.resolve();expect(changes).toEqual([changed]);expect(f.view.dom.querySelector('li[data-item-type="task"]')!.getAttribute('data-checked')).toBe(String(!checked))
 expect(await f.setMode('source')).toBe(true);expect((await f.owner.flush()).raw).toBe(changed);expect(await f.setMode('rich')).toBe(true)
 expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(raw)
 expect(f.owner.redo()).toBe(true);expect((await f.owner.flush()).raw).toBe(changed);expect(f.owner.snapshot().bindings).toEqual(bindings)
 f.view.dispatch(closeHistory(f.view.state.tr));click(f);expect(f.owner.snapshot().raw).toBe(changed.replace(/\[[ xX]\]/,checked?'[x]':'[ ]'))
 expect(undoDepth(f.view.state)).toBe(2);expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(changed)
 const reopened=await fixture((await f.owner.flush()).raw);expect(reopened.f.view.dom.querySelector('li[data-item-type="task"]')!.getAttribute('data-checked')).toBe(String(!checked))
})
it('nested checkbox changes only the clicked item, not its parent or siblings',async()=>{
 const raw='- [ ] parent\n  + [ ] __child__\n  + [X] sibling\n\n[id]: /target\n',{f}=await fixture(raw)
 click(f,1);expect(f.owner.snapshot().raw).toBe(raw.replace('[ ] __child__','[x] __child__'));expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(raw)
})
it('text/right-click, readonly and rejected policy never create source or history changes; retry works',async()=>{
 let allowed=false;const raw='- [ ] __task__\n\n[id]: /target\n',{f,changes}=await fixture(raw,()=>allowed),before=f.owner.snapshot()
 click(f,0,100);click(f,0,6,2);click(f);expect(f.owner.snapshot()).toEqual(before)
 allowed=true;f.owner.setReadOnly(true);click(f);expect(f.owner.snapshot()).toEqual(before);expect(undoDepth(f.view.state)).toBe(0);await Promise.resolve();expect(changes).toEqual([])
 f.owner.setReadOnly(false);click(f);expect(f.owner.snapshot().raw).toBe(raw.replace('[ ]','[x]'));expect(undoDepth(f.view.state)).toBe(1)
})
it('desktop RichEditor capture handlers and installed FileController accept a task in a footnoted document',async()=>{
 const {default:RichEditor}=await import('../components/RichEditor.svelte'),{tabs,activeId}=await import('../lib/tabs.svelte'),{fileEditorSession,closeFileEditorSession}=await import('../lib/file-editor-sessions')
 const raw='Summary[^source]\n\n- [ ] __中文任务。__\n  - Detail\n\n[^source]: Evidence.\n[^other]: Further evidence.\n'
 const tab={id:'checkbox-desktop',filePath:'/vault/task.md',title:'task.md',kind:'markdown' as const,mode:'rich' as const,currentContent:raw,initialContent:raw,externalState:'fresh' as const,externalBannerDismissed:false,lastKnownMtime:0,lastKnownHash:''}
 tabs.push(tab);activeId.value=tab.id;let ready=false;const component=mount(RichEditor,{target:document.body,props:{tab:tabs.find(t=>t.id===tab.id)!,fileBacked:true,onFileReady:()=>{ready=true}}})
 try{await vi.waitFor(()=>expect(ready).toBe(true));const f=fileEditorSession(tab.id)!;click(f);const changed=raw.replace('[ ]','[x]');expect((await f.owner.flush()).raw).toBe(changed);await vi.waitFor(()=>expect(tabs.find(t=>t.id===tab.id)!.currentContent).toBe(changed));expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(raw)}finally{await unmount(component);await closeFileEditorSession(tab.id);tabs.splice(0);activeId.value=null}
})
