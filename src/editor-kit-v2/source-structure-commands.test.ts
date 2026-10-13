// @vitest-environment happy-dom
import {expect,it} from 'vitest'
import {EditorState,TextSelection,type Transaction} from 'prosemirror-state'
import {EditorView} from 'prosemirror-view'
import {AttrStep} from 'prosemirror-transform'
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core'
import {executeEditorCommand} from './commands'
import type {EditorCommand} from './contract'
function open(raw:string){const r=createSourceSession(raw);if(!r.ok)throw Error(r.reason);return r.session}
function state(b:ReturnType<typeof open>,from:number,to=from){
 return EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,from,to)})
}
function text(doc:EditorState['doc'],needle:string){
 let at=-1;doc.descendants((n,p)=>{if(at<0&&n.isText){const i=n.text!.indexOf(needle);if(i>=0)at=p+i}})
 if(at<0)throw Error('missing fixture text');return at
}
function accept(b:ReturnType<typeof open>,tr:Transaction,expected?:string){
 tr.doc.check();const before=JSON.stringify(b),r=applySourceBlockTransaction(b,tr)
 expect(r.ok,r.ok?'accepted':r.reason).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(JSON.stringify(b)).toBe(before);expect(r.session.doc.eq(tr.doc)).toBe(true)
 expect(open(r.session.source).doc.eq(tr.doc)).toBe(true)
 expect(r.session.revision).toBe(b.revision+1)
 if(expected!==undefined)expect(Buffer.from(r.session.source)).toEqual(Buffer.from(expected))
 let at=0;const parts:string[]=[]
 for(const e of r.edits){expect(e.from).toBeGreaterThanOrEqual(at);parts.push(b.source.slice(at,e.from),e.text);at=e.to}
 parts.push(b.source.slice(at));expect(parts.join('')).toBe(r.session.source)
 return r
}
function reject(b:ReturnType<typeof open>,tr:Transaction){
 const before=JSON.stringify(b),r=applySourceBlockTransaction(b,tr)
 expect(r.ok).toBe(false);expect(r).not.toHaveProperty('session');expect(JSON.stringify(b)).toBe(before)
}
function kitTransaction(s:EditorState,action:EditorCommand):Transaction {
 const mount=document.createElement('div');document.body.appendChild(mount)
 let captured:Transaction|undefined
 const view:EditorView=new EditorView(mount,{state:s,dispatchTransaction(tr:Transaction){captured=tr;view.updateState(view.state.apply(tr))}})
 try {
  expect(executeEditorCommand(view,action)).toBe(true)
  if(!captured)throw Error('Kit command did not dispatch')
  return captured
 }finally{view.destroy();mount.remove()}
}
const tail='\n\nTail __raw__'
const table='| A | B |\n| --- | --- |\n| X | Y |'
it.each(['blockquote','bullet-list','ordered-list'] as const)('installed source accepts actual Kit %s producer',kind=>{
 const b=open('A\n\nB'+tail),tr=kitTransaction(state(b,1,4),{kind}),r=accept(b,tr)
 expect(r.changedRoots).toEqual([0,1]);expect(r.session.source.endsWith(tail)).toBe(true)
})
it.each(['indent','outdent'] as const)('installed source accepts actual Kit %s producer',kind=>{
 const b=open((kind==='indent'?'- A\n- B':'- A\n  - B')+tail),tr=kitTransaction(state(b,text(b.doc,'B')),{kind}),r=accept(b,tr)
 expect(r.changedRoots).toEqual([0]);expect(r.session.source.endsWith(tail)).toBe(true)
})
it.each(['table.add-row','table.add-column','table.delete-column'] as const)('installed source accepts actual Kit %s producer',kind=>{
 const b=open(table+tail),tr=kitTransaction(state(b,text(b.doc,'X')),{kind}),r=accept(b,tr)
 expect(r.changedRoots).toEqual([0]);expect(r.session.source.endsWith(tail)).toBe(true)
})
it('actual Kit next-cell appends row only at final cell',()=>{
 const b=open(table+tail),nav=kitTransaction(state(b,text(b.doc,'X')),{kind:'table.next-cell'})
 const noChange=applySourceBlockTransaction(b,nav);expect(noChange.ok).toBe(true)
 if(!noChange.ok)throw Error(noChange.reason);expect(noChange.session).toBe(b)
 const r=accept(b,kitTransaction(state(b,text(b.doc,'Y')),{kind:'table.next-cell'}))
 expect(r.changedRoots).toEqual([0]);expect(r.session.doc.child(0).childCount).toBe(3)
})
it.each(['right','center'])('actual Kit %s aligned add-row still rejects unfixed producer',align=>{
 const b=open(table.replace('--- | ---',align==='right'?'---: | ---:':':---: | :---:')+tail)
 reject(b,kitTransaction(state(b,text(b.doc,'X')),{kind:'table.add-row'}))
})
it('actual Kit header-only table deletion stays schema-valid and source-equivalent',()=>{
 const b=open(table+tail),r=accept(b,kitTransaction(state(b,text(b.doc,'X')),{kind:'table.delete-row'}))
 expect(r.session.doc.child(0).childCount).toBe(1)
 expect(r.session.source.endsWith(tail)).toBe(true)
})
it('actual Kit code-block empty language preserves strict source equality',()=>{
 const b=open('A'+tail),r=accept(b,kitTransaction(state(b,1),{kind:'code-block'}),'```\nA\n```'+tail)
 expect(r.session.doc.child(0).attrs.language).toBe('')
})
it('actual Kit edits only the selected second identical table',()=>{
 const b=open(table+'\n\n'+table+tail);let last=-1;b.doc.descendants((n,p)=>{if(n.isText&&n.text==='X')last=p})
 const r=accept(b,kitTransaction(state(b,last),{kind:'table.add-row'}))
 expect(r.changedRoots).toEqual([1]);expect(r.edits.every(e=>e.from>=b.roots[1]!.sourceFrom)).toBe(true)
})

it('actual Kit task-list remains atomic until checkbox source capture is supported',()=>{
 const b=open('A\n\nB'+tail),tr=kitTransaction(state(b,1,4),{kind:'task-list'})
 expect(tr.doc.child(0).child(0).attrs.checked).toBe(false);reject(b,tr)
})
it('actual Kit quote wrap preserves a closed code fence and its content LF',()=>{
 const b=open('```js\nA\n\n```'+tail),tr=kitTransaction(state(b,1),{kind:'blockquote'})
 const r=accept(b,tr,'> ```js\n> A\n> \n> ```'+tail)
 expect(r.changedRoots).toEqual([0])
})
it.each(['> ```js\n> A\n> ```','- ```js\n  A\n  ```'])(
 'installed AttrStep preserves closed nested fence: %j',raw=>{
  const b=open(raw+tail),at=text(b.doc,'A'),tr=state(b,at).tr.step(new AttrStep(at-1,'language','ts'))
  const r=accept(b,tr,raw.replace('```js','```ts')+tail)
  expect(r.changedRoots).toEqual([0])
 })
it.each(['```js\nA','> ```js\n> A','- ```js\n  A'])(
 'installed nested unclosed literal stays atomic: %j',raw=>{
  const b=open(raw),at=text(b.doc,'A')
  reject(b,state(b,at).tr.step(new AttrStep(at-1,'language','ts')))
  reject(b,state(b,at).tr.insertText('Z',at,at+1))
 })
