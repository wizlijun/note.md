// @vitest-environment happy-dom
import {it,expect,vi} from 'vitest';
import {EditorView} from 'prosemirror-view';
import {EditorState,TextSelection} from 'prosemirror-state';
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core';
import {openEditForMark,openEditForAnchor,insertNoteRich} from './note-commands';
import {noteUi} from './note-ui.svelte';
function mount(raw:string,path:readonly number[],endPath=path,endOffset=0){
 const opened=createSourceSession(raw);if(!opened.ok)throw Error(opened.reason);
 let base=opened.session;const values:string[]=[],steps:number[]=[];
 const pos=(indices:readonly number[],offset=0)=>{let node=base.doc,at=0;for(const index of indices){for(let i=0;i<index;i++)at+=node.child(i).nodeSize;at++;node=node.child(index)}return at+offset};
 const from=pos(path),to=pos(endPath,endOffset),container=document.createElement('div');document.body.append(container);
 const flushed=vi.fn();window.addEventListener('notemd:flush-doc',flushed);
 const view=new EditorView(container,{state:EditorState.create({doc:base.doc,selection:TextSelection.create(base.doc,from,to)}),dispatchTransaction(tr){
  const r=applySourceBlockTransaction(base,tr);expect(r.ok,r.ok?undefined:r.reason).toBe(true);if(!r.ok)throw Error(r.reason);
  expect(r.session.doc.eq(tr.doc)).toBe(true);base=r.session;values.push(base.source);steps.push(tr.steps.length);view.updateState(view.state.apply(tr));
 }});
 const realCoords=view.coordsAtPos.bind(view);view.coordsAtPos=()=>({left:0,right:1,top:0,bottom:1});
 return {view,from,values,steps,flushed,source:()=>base.source,destroy(){view.coordsAtPos=realCoords;noteUi.edit=null;noteUi.hover=null;view.destroy();container.remove();window.removeEventListener('notemd:flush-doc',flushed)}};
}
function bubble(raw:string,path:readonly number[],kind:'mark'|'point',expected:string){
 const m=mount(raw,path);try{(kind==='mark'?openEditForMark:openEditForAnchor)(m.view,m.from,new DOMRect(0,0,1,1));
  expect(noteUi.edit).not.toBeNull();noteUi.edit!.save('新注');expect(m.values).toHaveLength(1);expect(Buffer.from(m.source())).toEqual(Buffer.from(expected));
  if(kind==='mark')expect(m.steps[0]).toBeGreaterThan(1);expect(m.flushed).toHaveBeenCalledTimes(1);
 }finally{m.destroy()}
}
it('real range-note popup',()=>bubble('> {==Alpha _Beta_==}{>>原注<<}\n',[0,0],'mark','> {==Alpha _Beta_==}{>>新注<<}\n'));
it('real point-note popup',()=>bubble('{>>原注<<}目标甲。\n',[0],'point','{>>新注<<}目标甲。\n'));
it('real popup preserves two adjacent equal-note source occurrences',()=>bubble('{==A==}{>>原注<<}{==B==}{>>原注<<}\n',[0],'mark','{==A==}{>>新注<<}{==B==}{>>新注<<}\n'));
it('real insert-note then edit/remove consumes each new authoritative session',()=>{
 const m=mount('Alpha。\n',[0],[0],5);try{
  insertNoteRich(m.view,'?');expect(m.source()).toBe('{==Alpha==}{>>?<<}。\n');
  noteUi.edit!.save('新注');expect(m.source()).toBe('{==Alpha==}{>>新注<<}。\n');
  noteUi.edit!.remove();expect(m.source()).toBe('Alpha。\n');expect(m.values).toHaveLength(3);expect(m.flushed).toHaveBeenCalledTimes(3);
 }finally{m.destroy()}
});
const header='| H | J |\n| --- | --- |\n';
it.each([
 ['Alpha。\n',[0],'{>>?<<}Alpha。\n','{>>新注<<}Alpha。\n','Alpha。\n'],
 ['',[0],'{>>?<<}','{>>新注<<}',''],
 ['>\n',[0,0],'>{>>?<<}\n','>{>>新注<<}\n','>\n'],
 [header+'| A |   |\n',[0,1,1,0],header+'| A |{>>?<<}   |\n',header+'| A |{>>新注<<}   |\n',header+'| A |   |\n'],
 [header+'| A |\n',[0,1,1,0],header+'| A |{>>?<<}|\n',header+'| A |{>>新注<<}|\n',header+'| A ||\n'],
 ['| H | J | K |\n| --- | --- | --- |\n| A |\n',[0,1,2,0],'| H | J | K |\n| --- | --- | --- |\n| A ||{>>?<<}|\n','| H | J | K |\n| --- | --- | --- |\n| A ||{>>新注<<}|\n','| H | J | K |\n| --- | --- | --- |\n| A |||\n'],
] as const)('real point insert/save/remove: %s',(raw,path,inserted,saved,removed)=>{
 const m=mount(raw,path);try{insertNoteRich(m.view,'?');expect(m.source()).toBe(inserted);noteUi.edit!.save('新注');expect(m.source()).toBe(saved);noteUi.edit!.remove();expect(m.source()).toBe(removed);expect(m.values).toHaveLength(3);expect(m.flushed).toHaveBeenCalledTimes(3)}finally{m.destroy()}
});
it('real cross-paragraph insertion commits one atomic transaction with per-body syntax',()=>{
 const m=mount('Alpha _Beta_。\n\nTail。\n',[0],[1],4);try{
  insertNoteRich(m.view,'?');expect(m.source()).toBe('{==Alpha _Beta_。==}{>>?<<}\n\n{==Tail==}{>>?<<}。\n');expect(m.values).toHaveLength(1);
  noteUi.edit!.remove();expect(m.source()).toBe('Alpha _Beta_。\n\n{==Tail==}{>>?<<}。\n');
 }finally{m.destroy()}
});
it('real popup sanitation is consumed as the actual transaction note',()=>{
 const m=mount('{>>原注<<}A\n',[0]);try{openEditForAnchor(m.view,m.from,new DOMRect(0,0,1,1));noteUi.edit!.save('一\r\n二<<}');expect(m.source()).toBe('{>>一 二< <}<<}A\n')}finally{m.destroy()}
});
import {splitBlock} from 'prosemirror-commands';
it('real Enter and popup retain the nested empty paragraph count',()=>{
 const m=mount('> A',[0,0],[0,0],1);try{
  m.view.dispatch(m.view.state.tr.setSelection(TextSelection.create(m.view.state.doc,3)));
  const start=m.values.length;expect(splitBlock(m.view.state,tr=>m.view.dispatch(tr),m.view)).toBe(true);expect(m.source()).toBe('> A\n>');
  insertNoteRich(m.view,'?');expect(m.source()).toBe('> A\n>\n>{>>?<<}');noteUi.edit!.save('新注');expect(m.source()).toBe('> A\n>\n>{>>新注<<}');noteUi.edit!.remove();expect(m.source()).toBe('> A\n>');expect(m.values).toHaveLength(start+4);
 }finally{m.destroy()}
});
it('real repeated empty paragraph point lifecycle selects exactly one occurrence',()=>{
 const m=mount('> A\n>\n>',[0,2]);try{insertNoteRich(m.view,'?');expect(m.source()).toBe('> A\n>\n>\n>{>>?<<}');noteUi.edit!.save('新注');expect(m.source()).toBe('> A\n>\n>\n>{>>新注<<}');noteUi.edit!.remove();expect(m.source()).toBe('> A\n>\n>')}finally{m.destroy()}
});
it('actual mixed range note command cannot install the supported half',()=>{
 const opened=createSourceSession('Alpha\n\n$x$\n');if(!opened.ok)throw Error(opened.reason);const base=opened.session,container=document.createElement('div');document.body.append(container);let dispatched=0;
 const view=new EditorView(container,{state:EditorState.create({doc:base.doc,selection:TextSelection.create(base.doc,1,base.doc.content.size-1)}),dispatchTransaction(tr){dispatched++;expect(applySourceBlockTransaction(base,tr).ok).toBe(false)}});
 view.coordsAtPos=()=>({left:0,right:1,top:0,bottom:1});try{insertNoteRich(view,'?');expect(dispatched).toBe(1);expect(base.source).toBe('Alpha\n\n$x$\n');expect(view.state.doc).toBe(base.doc)}finally{noteUi.edit=null;noteUi.hover=null;view.destroy();container.remove()}
});
it.each([
 ['{>>原注<<}\n',[0],'{>>新注<<}\n',''],
 ['>{>>原注<<}\n>\n> [r]: /u\n',[0,0],'>{>>新注<<}\n>\n> [r]: /u\n','>\n> [r]: /u\n'],
 ['> [r]: /u\n>\n>{>>原注<<}\n',[0,0],'> [r]: /u\n>\n>{>>新注<<}\n','> [r]: /u\n>\n>\n'],
] as const)('real point-only popup save and remove retains authoritative layout: %s',(raw,path,saved,removed)=>{
 const m=mount(raw,path);try{openEditForAnchor(m.view,m.from,new DOMRect(0,0,1,1));noteUi.edit!.save('新注');expect(m.source()).toBe(saved);noteUi.edit!.remove();expect(m.source()).toBe(removed);expect(m.values).toHaveLength(2)}finally{m.destroy()}
});

it.each([
 ['**{>>原注<<}**\n',[0],'**{>>新注<<}**\n',''],
 ['\uFEFF***{>>原注<<}***\r\n',[0],'\uFEFF***{>>新注<<}***\r\n','\uFEFF'],
 ['**{>>原注<<}A**\n',[0],'**{>>新注<<}A**\n','**A**\n'],
 ['>**{>>原注<<}**\n>\n> [r]: /u\n',[0,0],'>**{>>新注<<}**\n>\n> [r]: /u\n','>\n> [r]: /u\n'],
 [header+'| A | *{>>原注<<}* |\n',[0,1,1,0],header+'| A | *{>>新注<<}* |\n',header+'| A |  |\n'],
] as const)('installed final I2 real popup removes only empty mark wrappers: %s',(raw,path,saved,removed)=>{
 const m=mount(raw,path);try{openEditForAnchor(m.view,m.from,new DOMRect(0,0,1,1));noteUi.edit!.save('新注');expect(m.source()).toBe(saved);noteUi.edit!.remove();expect(m.source()).toBe(removed);expect(m.values).toHaveLength(2);expect(m.flushed).toHaveBeenCalledTimes(2)}finally{m.destroy()}
 const reopened=createSourceSession(removed);expect(reopened.ok).toBe(true);
});
it('installed final I2 real removed marked point supports a reopened session and next point lifecycle',()=>{
 const first=mount('***{>>原注<<}***\n',[0]);let removed='';try{openEditForAnchor(first.view,first.from,new DOMRect(0,0,1,1));noteUi.edit!.remove();removed=first.source();expect(removed).toBe('')}finally{first.destroy()}
 const next=mount(removed,[0]);try{insertNoteRich(next.view,'?');expect(next.source()).toBe('{>>?<<}');noteUi.edit!.save('新注');expect(next.source()).toBe('{>>新注<<}');noteUi.edit!.remove();expect(next.source()).toBe('')}finally{next.destroy()}
});


it.each(['{>>原注<<}','**{>>原注<<}**'])('real definition-only popup removal supports same-session consecutive text: %s',point=>{
 const raw='>'+point+'\n>\n> [r]: /u\n',m=mount(raw,[0,0]);
 try{
  openEditForAnchor(m.view,m.from,new DOMRect(0,0,1,1));noteUi.edit!.remove();expect(m.source()).toBe('>\n> [r]: /u\n');
  m.view.dispatch(m.view.state.tr.insertText('Z',2));expect(m.source()).toBe('>Z\n>\n> [r]: /u\n');
  m.view.dispatch(m.view.state.tr.insertText('Q',3));expect(m.source()).toBe('>ZQ\n>\n> [r]: /u\n');
  expect(m.values).toHaveLength(3);expect(m.flushed).toHaveBeenCalledTimes(1);
 }finally{m.destroy()}
 const reopened=mount('>ZQ\n>\n> [r]: /u\n',[0,0]);
 try{reopened.view.dispatch(reopened.view.state.tr.insertText('R',4));expect(reopened.source()).toBe('>ZQR\n>\n> [r]: /u\n')}finally{reopened.destroy()}
});
