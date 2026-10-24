/** @vitest-environment happy-dom */
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>null),convertFileSrc:(s:string)=>s}))
vi.mock('@tauri-apps/plugin-dialog',()=>({open:vi.fn()}))
vi.mock('@tauri-apps/plugin-fs',()=>({readFile:vi.fn(async()=>new Uint8Array([137,80,78,71])),exists:vi.fn(async()=>true)}))
vi.mock('@tauri-apps/plugin-os',()=>({platform:()=> 'macos',type:()=> 'macos'}))
const native=vi.hoisted(()=>({drop:null as null|((event:{payload:{type:string;paths:string[];position:{x:number;y:number}}})=>Promise<void>)}))
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async(callback:typeof native.drop)=>{native.drop=callback;return ()=>{native.drop=null}}})}))
import {TextSelection,NodeSelection} from 'prosemirror-state'
import {closeHistory,undoDepth,redoDepth} from 'prosemirror-history'
import {neutralize} from './file-projection'
import {DOMParser} from 'prosemirror-model'
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver'
import {mountFileEditor,type FileMountSession} from './file-main'
import {insertImageAtCursor,insertImageAtPos} from '../lib/attachment-insert'
import {mount,unmount,tick} from 'svelte'
const editors:FileMountSession[]=[]
afterEach(async()=>{for(const f of editors.splice(0))await f.owner.close();document.body.replaceChildren();vi.restoreAllMocks()})
async function fixture(raw:string,policy=()=>true){
 const target=document.createElement('div');document.body.append(target)
 const changes:string[]=[],f=await mountFileEditor(target,{file:{documentId:'image.md',authority:'A',raw},adapters:{mediaResolver:new BrowserMediaResolver()},policy:{acceptRawChange:(before,after)=>before===after||policy()},onChange:s=>changes.push(s.raw)},{});editors.push(f);return {f,changes,target}
}
function select(f:FileMountSession,from:number,to=from){f.view.dispatch(f.view.state.tr.setSelection(TextSelection.create(f.view.state.doc,from,to)))}
function separate(f:FileMountSession){f.view.dispatch(closeHistory(f.view.state.tr))}
it('real cursor image, resize, delete retain three independent native history events and bindings through Source/save',async()=>{
 const raw='__Keep__ AB\r\n', {f,changes}=await fixture(raw),owner=f.owner,binding=owner.snapshot().bindings[0].id
 select(f,6,8);insertImageAtCursor(f.view,'/x');expect(owner.snapshot().raw).toBe('__Keep__ ![](/x)\r\n');expect(undoDepth(f.view.state)).toBe(1)
 separate(f);f.view.dispatch(f.view.state.tr.setNodeMarkup(6,undefined,{...f.view.state.doc.nodeAt(6)!.attrs,title:'width=50%'}));const resized='__Keep__ ![](/x "width=50%")\r\n';expect(owner.snapshot().raw).toBe(resized);expect(undoDepth(f.view.state)).toBe(2)
 separate(f);f.view.dispatch(f.view.state.tr.setSelection(NodeSelection.create(f.view.state.doc,6)).deleteSelection());expect(owner.snapshot().raw).toBe('__Keep__&#32;\r\n');expect(undoDepth(f.view.state)).toBe(3)
 for(const expected of [resized,'__Keep__ ![](/x)\r\n',raw]){expect(owner.undo()).toBe(true);expect(owner.snapshot().raw).toBe(expected)}
 for(const expected of ['__Keep__ ![](/x)\r\n',resized,'__Keep__&#32;\r\n']){expect(owner.redo()).toBe(true);expect(owner.snapshot().raw).toBe(expected)}
 expect(await f.setMode('source')).toBe(true);expect((await owner.flush()).raw).toBe('__Keep__&#32;\r\n');expect(await f.setMode('rich')).toBe(true);expect(f.owner).toBe(owner);expect(undoDepth(f.view.state)).toBe(3);expect(owner.snapshot().bindings[0].id).toBe(binding);expect(changes).toHaveLength(9)
})
it.each(['selection','stored','position'] as const)('actual helper %s preserves its mark semantics',async kind=>{
 const {f}=await fixture('__Keep__ AB');select(f,kind==='selection'?1:6,kind==='selection'?5:6)
 if(kind==='stored')f.view.dispatch(f.view.state.tr.setStoredMarks([f.view.state.schema.marks.strong.create()]))
 if(kind==='position')insertImageAtPos(f.view,'/x',6);else insertImageAtCursor(f.view,'/x')
 expect(f.owner.snapshot().raw).toBe(kind==='selection'?'__![](/x)__ AB':kind==='stored'?'__Keep__ **![](/x)**&#65;B':'__Keep__ ![](/x)AB')
})
it('actual clipboardTextParser and HTML image slice reach the installed controller',async()=>{
 const {f}=await fixture('AB');select(f,1,3)
 const parser=f.view.someProp('clipboardTextParser');expect(parser).toBeTypeOf('function')
 const slice=parser!('![a](/x)',f.view.state.selection.$from,false,f.view);f.view.dispatch(f.view.state.tr.replaceSelection(slice));expect(f.owner.snapshot().raw).toBe('![a](/x)')
 const dom=document.createElement('div');dom.innerHTML='<img src="/y" alt="b" title="width=300">';const html=DOMParser.fromSchema(f.view.state.schema).parseSlice(dom)
 select(f,1,2);f.view.dispatch(f.view.state.tr.replaceSelection(html));expect(f.owner.snapshot().raw).toBe('![b](/y "width=300")')
})
it('readonly/policy rejects helper and slash atomically; legal retry preserves trigger',async()=>{
 let allowed=false;const {f,changes}=await fixture('/image',()=>allowed);select(f,7);const before=f.owner.snapshot()
 expect(f.insertSlashAttachment('image','/x')).toBe(false);expect(f.owner.snapshot()).toEqual(before);expect(changes).toEqual([]);expect(undoDepth(f.view.state)).toBe(0)
 allowed=true;f.owner.setReadOnly(true);insertImageAtCursor(f.view,'/x');expect(f.owner.snapshot()).toEqual(before);f.owner.setReadOnly(false)
 expect(f.insertSlashAttachment('image','/x')).toBe(true);expect(f.owner.snapshot().raw).toBe('![](/x)');expect(undoDepth(f.view.state)).toBe(1);expect(redoDepth(f.view.state)).toBe(0)
})
async function desktop(raw:string,run:(f:FileMountSession)=>Promise<void>){
 const {default:RichEditor}=await import('../components/RichEditor.svelte'),{tabs,activeId}=await import('../lib/tabs.svelte'),{fileEditorSession,closeFileEditorSession}=await import('../lib/file-editor-sessions')
 const tab={id:'image-desktop',filePath:'/vault/image.md',title:'image.md',kind:'markdown' as const,mode:'rich' as const,currentContent:raw,initialContent:raw,externalState:'fresh' as const,externalBannerDismissed:false,lastKnownMtime:0,lastKnownHash:''}
 tabs.push(tab);activeId.value=tab.id;const component=mount(RichEditor,{target:document.body,props:{tab,fileBacked:true}})
 try{await vi.waitFor(()=>expect(fileEditorSession(tab.id)).toBeDefined());await run(fileEditorSession(tab.id)!)}finally{await unmount(component);await closeFileEditorSession(tab.id);tabs.splice(0);activeId.value=null}
}
it.each([false,true] as const)('actual binary paste image checks asynchronous target: stale=%s',async stale=>{
 const resources=await import('../lib/paste-resources');let resolve!:(path:string)=>void
 const save=vi.spyOn(resources,'saveClipboardResource').mockImplementation(()=>new Promise(r=>{resolve=r}))
 await desktop('AB',async f=>{select(f,1,3);const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{items:[{kind:'file',type:'image/png',getAsFile:()=>new File(['x'],'x.png',{type:'image/png'})}]}});f.view.dom.dispatchEvent(event);expect(save).toHaveBeenCalledOnce();if(stale)expect(f.owner.installBaseline({documentId:'new',authority:'A',raw:'AB'}).ok).toBe(true);resolve('/x');await tick();await Promise.resolve();expect(f.owner.snapshot().raw).toBe(stale?'AB':'![](/x)')})
})
it.each(['accept','cancel','stale'] as const)('actual context image dialog %s',async kind=>{
 const dialog=await import('@tauri-apps/plugin-dialog');let resolve!:(path:string|null)=>void;vi.mocked(dialog.open).mockReset().mockImplementation(()=>new Promise<string|null>(r=>{resolve=r}))
 await desktop('AB',async f=>{select(f,1,3);f.view.dom.querySelector('p')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:10,clientY:10}));await tick();const insert=[...document.querySelectorAll<HTMLElement>('.menu-row')].find(n=>/^(Insert|插入)/i.test(n.textContent?.trim()??''));expect(insert).toBeTruthy();insert!.dispatchEvent(new MouseEvent('mouseenter'));await tick();const row=[...document.querySelectorAll<HTMLElement>('.menu-row')].find(n=>/^(Image|图片)/i.test(n.textContent?.trim()??''));expect(row).toBeTruthy();row!.click();await vi.waitFor(()=>expect(dialog.open).toHaveBeenCalled());if(kind==='stale'){expect(f.owner.installBaseline({documentId:'new',authority:'A',raw:'AB'}).ok).toBe(true);select(f,1,3)}resolve(kind==='cancel'?null:'/x');await tick();await new Promise(r=>setTimeout(r,0));expect(f.owner.snapshot().raw).toBe(kind==='accept'?'![](/x)':'AB')})
})
it('actual native drop callback uses the observed coordinate position helper (API simulated)',async()=>{
 await desktop('AB',async f=>{await vi.waitFor(()=>expect(native.drop).toBeTypeOf('function'));vi.spyOn(f.view,'posAtCoords').mockReturnValue({pos:2,inside:0});await native.drop!({payload:{type:'drop',paths:['/x.png'],position:{x:10,y:10}}});expect(f.owner.snapshot().raw).toBe('A![](/x.png)B')})
})
it.each(['accept','cancel','stale'] as const)('actual slash image dialog %s retains trigger until accepted',async kind=>{
 const dialog=await import('@tauri-apps/plugin-dialog');let resolve!:(path:string|null)=>void;vi.mocked(dialog.open).mockReset().mockImplementation(()=>new Promise<string|null>(r=>{resolve=r}))
 await desktop('/image',async f=>{select(f,7);f.view.dom.dispatchEvent(new Event('input',{bubbles:true}));await tick();const row=[...document.querySelectorAll<HTMLElement>('.menu-row')].find(n=>/image|图片/i.test(n.textContent??''));expect(row).toBeTruthy();row!.click();await vi.waitFor(()=>expect(dialog.open).toHaveBeenCalled());expect(f.owner.snapshot().raw).toBe('/image');if(kind==='stale'){expect(f.owner.installBaseline({documentId:'new',authority:'A',raw:'/image'}).ok).toBe(true);select(f,7)}resolve(kind==='cancel'?null:'/x');await tick();await new Promise(r=>setTimeout(r,0));expect(f.owner.snapshot().raw).toBe(kind==='accept'?'![](/x)':'/image')})
})
it('actual native path helper creates a representable initial image node',async()=>{
 const {f}=await fixture('AB');select(f,1,3);insertImageAtCursor(f.view,'/a b.png');expect(f.owner.snapshot().raw).toBe('![](</a%20b.png>)')
})
it('actual slash native-space path is represented before its original Step',async()=>{
 const {f}=await fixture('/image');select(f,7);expect(f.insertSlashAttachment('image','/a b.png')).toBe(true);expect(f.owner.snapshot().raw).toBe('![](</a%20b.png>)')
})
it.each([
 ['/a b.png','/a%20b.png','![](</a%20b.png>)'],
 ['/a#b?.png','/a%23b%3F.png','![](</a%23b%3F.png>)'],
 ['/a(b).png','/a(b).png','![](</a(b).png>)'],
 ['/a%20b%25.png','/a%2520b%2525.png','![](</a%2520b%2525.png>)'],
 ['/中文.png','/中文.png','![](/中文.png)'],
 ['C:\\图片\\a b%20.png','C:\\图片\\a%20b%2520.png','![](<C:%5C图片%5Ca%20b%2520.png>)'],
] as const)('native path %s survives actual src, strict source and resolver once',(async(path,src,raw)=>{
 const {localResourceCandidates}=await import('../lib/local-resource'),{parseMarkdown}=await import('@moraya/core/markdown');const {f}=await fixture('AB');select(f,1,3);insertImageAtCursor(f.view,path)
 expect(f.owner.snapshot().raw).toBe(raw);expect(f.view.state.doc.nodeAt(1)!.attrs.src).toBe(src)
 expect(parseMarkdown(raw,f.view.state.schema).eq(neutralize(f.view.state.doc))).toBe(true)
 expect(localResourceCandidates(src,{baseDir:'/vault'})).toContain(path.replace(/\\/g,'/'))
}))
it('HTML and Markdown encoded image sources bypass native path encoding',async()=>{
 const {f}=await fixture('AB');select(f,1,3);const parser=f.view.someProp('clipboardTextParser')!;f.view.dispatch(f.view.state.tr.replaceSelection(parser('![](</a%20b%25.png>)',f.view.state.selection.$from,false,f.view)));expect(f.owner.snapshot().raw).toBe('![](</a%20b%25.png>)')
 const dom=document.createElement('div');dom.innerHTML='<img src="/a%20b%25.png">';select(f,1,2);f.view.dispatch(f.view.state.tr.replaceSelection(DOMParser.fromSchema(f.view.state.schema).parseSlice(dom)));expect(f.owner.snapshot().raw).toBe('![](</a%20b%25.png>)')
})

it.each(['strong','em'] as const)('actual marked helper and plain image endpoint typing preserve %s native history',async kind=>{
 const wrapper=kind==='strong'?'**':'*', {f}=await fixture('AB');select(f,1);f.view.dispatch(f.view.state.tr.setStoredMarks([f.view.state.schema.marks[kind]!.create()]));insertImageAtCursor(f.view,'/x');const inserted=wrapper+'![](/x)'+wrapper+'&#65;B';expect(f.owner.snapshot().raw).toBe(inserted);expect(undoDepth(f.view.state)).toBe(1)
 separate(f);f.view.dispatch(f.view.state.tr.setStoredMarks([]).insertText('中',2));const typed=wrapper+'![](/x)'+wrapper+'&#20013;&#65;B';expect(f.owner.snapshot().raw).toBe(typed);expect(undoDepth(f.view.state)).toBe(2)
 expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe(inserted);expect(f.owner.undo()).toBe(true);expect(f.owner.snapshot().raw).toBe('AB');expect(f.owner.redo()).toBe(true);expect(f.owner.snapshot().raw).toBe(inserted);expect(f.owner.redo()).toBe(true);expect(f.owner.snapshot().raw).toBe(typed)
})


it.each([
  ['![diagram](</vault/a%20b.png>)', 'img', true],
  ['[report](</vault/report%20one.pdf>)', 'a[href], [data-url]', false],
  ['![remote](https://example.com/image.png)', 'img', true],
  ['[remote](https://example.com/report.pdf)', 'a[href], [data-url]', false],
] as const)('desktop Rich resource menu uses the clicked %s and leaves source intact', async (raw, selector, image) => {
  await desktop(raw, async f => {
    await vi.waitFor(() => expect(f.view.dom.querySelector(selector)).toBeTruthy())
    const target = f.view.dom.querySelector(selector)
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
    target!.dispatchEvent(event); await tick()
    expect(event.defaultPrevented).toBe(true)
    const labels = [...document.querySelectorAll('.ctx-menu .ctx-label')].map(el => el.textContent)
    expect(labels).toEqual([...(raw.includes('https://') ? [] : ['Copy Filename']), ...(image ? ['Copy Image'] : []), 'Save As…'])
    expect(document.querySelector('.ctx-menu.menu-panel')).toBeTruthy()
    expect(f.owner.snapshot().raw).toBe(raw)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await tick()
    expect(document.querySelector('.ctx-menu')).toBeNull()
  })
})
