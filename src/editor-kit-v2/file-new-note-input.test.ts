/** @vitest-environment happy-dom */
import {afterEach,expect,it,vi} from 'vitest'
vi.mock('../lib/platform-sync',()=>({isApplePlatformSync:()=>true}))
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(async()=>null),convertFileSrc:(s:string)=>s}))
vi.mock('@tauri-apps/plugin-os',()=>({platform:()=> 'macos',type:()=> 'macos'}))
vi.mock('@tauri-apps/api/webview',()=>({getCurrentWebview:()=>({onDragDropEvent:async()=>()=>{}})}))
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver'
import {mountFileEditor,type FileMountSession} from './file-main'
import {createImeGuard} from '../lib/ime'
import {newFileText} from '../lib/new-file'
import {applySelectAll} from '../lib/editor-select-all'
import {focusRichBodyEnd} from '../lib/rich-editor-focus'

// Regression for "new markdown → type one line in Rich → Enter does nothing,
// ⌘A + Delete does nothing". Exercises the real mount path a new note takes:
// OKF frontmatter-only source, caret placed by focusRichBodyEnd, keydown Enter.

const sessions:FileMountSession[]=[]
afterEach(async()=>{for(const s of sessions.splice(0)){s.destroyView();await s.owner.close().catch(()=>{})};document.body.replaceChildren();vi.restoreAllMocks()})
const plain=newFileText('')
const signed=newFileText('',{by:'human:tester',at:'2026-11-20T00:00:00.000Z'})
const header=(raw:string)=>raw.endsWith('\n')?raw:raw+'\n'
async function newNote(raw:string){
 const target=document.createElement('div');document.body.append(target)
 let now=0
 const ime=createImeGuard(()=>now)
 const session=await mountFileEditor(target,{file:{documentId:'new-note.md',authority:'A',raw},adapters:{mediaResolver:new BrowserMediaResolver()}},{styles:'host',imeGuard:ime})
 sessions.push(session)
 expect(focusRichBodyEnd(session.view,session.owner)).toBe(true)
 return {session,ime,advance:(ms:number)=>{now+=ms}}
}
function press(session:FileMountSession,key:string){
 const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true})
 session.view.dom.dispatchEvent(event)
 return event
}
const type=(session:FileMountSession,text:string)=>session.view.dispatch(session.view.state.tr.insertText(text))
const why=(session:FileMountSession)=>String((session.baselineIdentity as {diagnostic:unknown}).diagnostic)

it.each([['unsigned',plain],['signed',signed],['empty file','']])('%s new note: type a line, Enter, type the next line',async(_name,raw)=>{
 const {session}=await newNote(raw)
 const warn=vi.spyOn(console,'warn')
 type(session,'first line')
 expect(press(session,'Enter').defaultPrevented).toBe(true)
 type(session,'second line')
 const prefix=raw?header(raw)+'\n':''
 expect(session.owner.snapshot().raw,why(session)).toBe(prefix+'first line\n\nsecond line\n')
 expect(warn).not.toHaveBeenCalledWith('[note.md] rich edit rejected',expect.anything())
 // Enter again at the end of the (now last) line still works.
 press(session,'Enter');type(session,'third')
 expect(session.owner.snapshot().raw,why(session)).toBe(prefix+'first line\n\nsecond line\n\nthird\n')
})

const notes=[['unsigned',plain],['signed',signed],['empty file','']] as const
it.each(notes.flatMap(([name,raw])=>(['Backspace','Delete'] as const).flatMap(key=>([1,2] as const).map(lines=>[name,key,lines,raw] as const))))
('%s new note: select-all + %s after typing %i line(s) clears the body and keeps metadata',async(_name,key,lines,raw)=>{
 const {session}=await newNote(raw)
 type(session,'first line');if(lines===2){press(session,'Enter');type(session,'second line')}
 applySelectAll(session.view)
 expect(session.view.state.selection.empty).toBe(false)
 expect(press(session,key).defaultPrevented).toBe(true)
 const left=session.owner.snapshot().raw
 expect(left,why(session)).not.toContain('first line')
 expect(left).not.toContain('second line')
 if(raw)expect(left.startsWith(header(raw))).toBe(true)
 // The emptied note is still writable.
 type(session,'again')
 expect(session.owner.snapshot().raw,why(session)).toContain('again')
})

it('new note: IME-composed first line, then Enter splits after compositionend',async()=>{
 const {session,ime,advance}=await newNote(plain)
 session.view.dom.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))
 session.view.dispatch(session.view.state.tr.insertText('中文').setMeta('composition',1))
 expect(ime.blocks(new KeyboardEvent('keydown',{key:'Enter'}))).toBe(true)
 session.view.dom.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))
 await new Promise(resolve=>setTimeout(resolve,20))
 advance(100) // past the guard's post-compositionend tail
 expect(ime.blocks(new KeyboardEvent('keydown',{key:'Enter'}))).toBe(false)
 expect(press(session,'Enter').defaultPrevented).toBe(true)
 type(session,'下一行')
 expect((await session.owner.flush()).raw,why(session)).toBe(header(plain)+'\n中文\n\n下一行\n')
})
