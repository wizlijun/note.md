import {expect,it} from 'vitest'
import {EditorState,TextSelection,type Transaction,type Command} from 'prosemirror-state'
import {splitBlock,joinBackward,wrapIn} from 'prosemirror-commands'
import {AddMarkStep,RemoveMarkStep,AttrStep} from 'prosemirror-transform'
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core'
function open(raw:string){const r=createSourceSession(raw);if(!r.ok)throw Error(r.reason);return r.session}
function state(b:ReturnType<typeof open>,from:number,to=from){
 return EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,from,to)})
}
function command(s:EditorState,cmd:Command):Transaction {
 let out:Transaction|undefined
 expect(cmd(s,tr=>{out=tr})).toBe(true)
 if(!out)throw Error('command did not dispatch')
 return out
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
function childPos(doc:EditorState['doc'],index:number){
 let pos=0;for(let i=0;i<index;i++)pos+=doc.child(i).nodeSize;return pos
}
function deleteChild(b:ReturnType<typeof open>,index:number){
 const p=childPos(b.doc,index);return EditorState.create({doc:b.doc}).tr.delete(p,p+b.doc.child(index).nodeSize)
}
it('splitBlock produces two children inside one raw owner',()=>{
 const b=open('HelloWorld\n\nTail __raw__\r\n')
 const tr=command(state(b,6),splitBlock),r=accept(b,tr,'Hello\n\nWorld\n\nTail __raw__\r\n')
 expect(r.changedRoots).toEqual([0]);expect(r.edits).toHaveLength(1)
 expect(r.edits[0]!.from).toBe(0);expect(r.edits[0]!.to).toBeLessThanOrEqual(b.roots[0]!.sourceTo)
})
it('real joinBackward consumes only crossed seam',()=>{
 const b=open('A\n\nB\n\nC __raw__'),tr=command(state(b,text(b.doc,'B')),joinBackward)
 const r=accept(b,tr,'AB\n\nC __raw__');expect(r.changedRoots).toEqual([0,1])
 expect(r.edits.every(e=>e.to<=b.roots[1]!.sourceTo)).toBe(true)
})
it.each([
 ['A\n\nB\n\nC',1,'A\n\nC'],['A\n\nB',0,'B'],['A\n\nB',1,'A\n'],
 ['A\n\nB\n\n',1,'A\n\n'],['A\n\n\nB',1,'A\n\nB'],
 ['- A\n\n\nB',1,'- A\n\nB'],['- A\n\n\nB',0,'\nB'],
 ['A\n\n',0,''],['- A\n\n\n',0,'\n'],
 ['\uFEFFA\r\n \t\r\n\t\r\n',0,'\uFEFF\t\r\n'],
 ['A\n\n[ref]: /u\n\n',0,'\n[ref]: /u\n\n'],
 ['A\n\n\n[ref]: /u\n\n',0,'\n[ref]: /u\n\n'],
] as const)('finite deletion %j',(raw,index,expected)=>{
 const b=open(raw);accept(b,deleteChild(b,index),expected)
})
it('boundary birth keeps changedRoots empty through later edit',()=>{
 const b=open('A\n\nC'),p=childPos(b.doc,1),tr=EditorState.create({doc:b.doc}).tr
 tr.insert(p,b.doc.type.schema.nodes.paragraph!.create(null,b.doc.type.schema.text('B')))
 tr.insertText('ee',p+2)
 const r=accept(b,tr,'A\n\nBee\n\nC')
 expect(r.changedRoots).toEqual([]);expect(r.edits).toEqual([{from:3,to:3,text:'Bee\n\n'}])
})
it('same-point births follow final order and produce one edit',()=>{
 const b=open('A\n\nC'),p=childPos(b.doc,1),tr=EditorState.create({doc:b.doc}).tr
 const paragraph=b.doc.type.schema.nodes.paragraph!,word=(s:string)=>paragraph.create(null,b.doc.type.schema.text(s))
 tr.insert(p,word('B'));tr.insert(p,word('X'))
 const r=accept(b,tr,'A\n\nX\n\nB\n\nC')
 expect(r.edits).toEqual([{from:3,to:3,text:'X\n\nB\n\n'}])
})
it('delete tombstone then insert stays at deleted owner',()=>{
 const b=open('A\n\nB\n\nC'),p=childPos(b.doc,1),tr=deleteChild(b,1)
 tr.insert(p,b.doc.type.schema.nodes.paragraph!.create(null,b.doc.type.schema.text('X')))
 const r=accept(b,tr,'A\n\nX\n\nC');expect(r.changedRoots).toEqual([1])
 expect(r.edits.every(e=>e.from>=3&&e.to<=6)).toBe(true)
})
it('empty document Enter has one generated blank unit',()=>{
 const b=open(''),tr=command(state(b,1),splitBlock),r=accept(b,tr,'\n')
 expect(r.changedRoots).toEqual([]);expect(r.session.layout.fallback).toBeDefined()
})

it.each([
 ['A\n\nB',1,'A\n\n\nB',3,'\n'],
 ['A',1,'A\n\n',1,'\n\n'],
 ['A\n',1,'A\n\n',2,'\n'],
 ['A',0,'\nA',0,'\n'],
] as const)('empty birth slot %j',(raw,index,expected,anchor,insert)=>{
 const b=open(raw),tr=EditorState.create({doc:b.doc}).tr.insert(childPos(b.doc,index),b.doc.type.schema.nodes.paragraph!.create())
 expect(accept(b,tr,expected).edits).toEqual([{from:anchor,to:anchor,text:insert}])
})
it('deleting rawless baseline converts exactly the first surviving unit',()=>{
 const b=open('\n\n');expect(accept(b,deleteChild(b,0),'\n').edits).toEqual([{from:0,to:1,text:''}])
})
it('birth then disappearance is unchanged',()=>{
 const b=open('A\n\nC'),p=childPos(b.doc,1),tr=EditorState.create({doc:b.doc}).tr
 tr.insert(p,b.doc.type.schema.nodes.paragraph!.create(null,b.doc.type.schema.text('B')));tr.delete(p,p+3)
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true)
 if(!r.ok)throw Error(r.reason);expect(r.session).toBe(b);expect(r.edits).toEqual([])
})
it('duplicate text roots retain identity when deleting only second',()=>{
 const b=open('A\r\n\nA');expect(accept(b,deleteChild(b,1),'A\r\n').changedRoots).toEqual([1])
})
it('nonadjacent splits preserve intervening raw root and gaps',()=>{
 const b=open('HelloWorld\n \t\nMiddle __raw__\r\n\t\r\nByeWorld'),s=state(b,text(b.doc,'ByeWorld')+3)
 const tr=command(s,splitBlock);tr.split(text(b.doc,'HelloWorld')+5)
 const r=accept(b,tr,'Hello\n\nWorld\n \t\nMiddle __raw__\r\n\t\r\nBye\n\nWorld')
 expect(r.changedRoots).toEqual([0,2]);expect(r.edits).toHaveLength(2)
 expect(r.edits[0]!.to).toBeLessThanOrEqual(b.roots[0]!.sourceTo)
 expect(r.edits[1]!.from).toBe(b.roots[2]!.sourceFrom)
})
it.each([false,true])('same-anchor births and edited origin follow final PM order (%s)',twoBirths=>{
 const b=open('A\n\nC'),tr=EditorState.create({doc:b.doc}).tr
 const paragraph=(word:string)=>b.doc.type.schema.nodes.paragraph!.create(null,b.doc.type.schema.text(word))
 if(twoBirths){tr.insert(3,paragraph('B'));tr.insert(3,paragraph('X'));tr.insertText('ee',11)}
 else {tr.insertText('ee',5);tr.insert(3,paragraph('B'))}
 const expected=twoBirths?'A\n\nX\n\nB\n\nCee':'A\n\nB\n\nCee'
 expect(open(expected).doc.eq(tr.doc)).toBe(true)
 const r=accept(b,tr,expected)
 expect(r.changedRoots).toEqual([1])
 expect(r.edits).toEqual([{from:3,to:4,text:twoBirths?'X\n\nB\n\nCee':'B\n\nCee'}])
})
it.each([false,true])('ineffective mark over a raw empty preserves its unit through split (%s)',remove=>{
 const b=open(remove?'**AB**\r\n\r\n \t\r\n**C**':'AB\r\n\r\n \t\r\nC')
 const tr=EditorState.create({doc:b.doc}).tr,strong=b.doc.type.schema.marks.strong!.create()
 tr.step(remove?new RemoveMarkStep(1,b.doc.content.size-1,strong):new AddMarkStep(1,b.doc.content.size-1,strong))
 tr.split(2)
 const expected=remove?'A\n\nB\r\n\r\n \t\r\nC':'**A**\n\n**B**\r\n\r\n \t\r\n**C**'
 expect(open(expected).doc.eq(tr.doc)).toBe(true)
 const r=accept(b,tr,expected),unit=b.layout.blankLines.find(u=>u.role==='empty-paragraph')!
 expect(r.edits.every(e=>e.to<=unit.sourceFrom||e.from>=unit.sourceTo)).toBe(true)
})

it('installed structural wrap joins roots while preserving external mixed-EOL raw',()=>{
 const b=open('A\r\n\r\nB\r\n \t\r\nTail __raw__'),tr=command(state(b,1,4),wrapIn(b.doc.type.schema.nodes.blockquote!))
 const r=accept(b,tr);expect(r.changedRoots).toEqual([0,1]);expect(r.session.source.endsWith('\r\n \t\r\nTail __raw__')).toBe(true)
})
it('installed source split keeps leading spaces as text entities',()=>{
 const b=open('Hello world\n\nTail'),r=accept(b,command(state(b,6),splitBlock))
 expect(r.session.source).toBe('Hello\n\n&#32;world\n\nTail')
})
it('installed source AttrStep preserves fence content LF and raw external tail',()=>{
 const b=open('```js\nA\n\n```\r\n\r\nTail __raw__'),r=accept(b,state(b,1).tr.step(new AttrStep(0,'language','ts')))
 expect(r.session.doc.child(0).textContent).toBe('A\n');expect(r.session.source.endsWith('```\r\n\r\nTail __raw__')).toBe(true)
})
