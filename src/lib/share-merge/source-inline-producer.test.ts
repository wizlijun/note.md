// @vitest-environment happy-dom
import {it,expect} from 'vitest';import {EditorView} from 'prosemirror-view';
import {EditorState,TextSelection} from 'prosemirror-state';
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core';
import {executeEditorCommand} from '../../editor-kit-v2/commands';
import type {EditorCommand} from '../../editor-kit-v2/contract';
import {propose} from './proposal';
function toolbar(raw:string,from:number,to:number,action:EditorCommand,expected:string){
 const b=createSourceSession(raw);if(!b.ok)throw Error(b.reason);
 const container=document.createElement('div');document.body.append(container);
 let source=raw;const seen:number[]=[];
 const view=new EditorView(container,{state:EditorState.create({doc:b.session.doc,
  selection:TextSelection.create(b.session.doc,from,to)}),dispatchTransaction(tr){
   const r=applySourceBlockTransaction(b.session,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
   source=r.session.source;seen.push(tr.steps.length);view.updateState(view.state.apply(tr));
 }});
 try{expect(executeEditorCommand(view,action)).toBe(true);expect(seen).toHaveLength(1);
  expect(Buffer.from(source)).toEqual(Buffer.from(expected));
  const p=propose({path:'inline.md',base:raw,ours:raw,theirs:source});
  expect(p.theirsEolAligned).toBe(false);expect(p.hunks.length).toBeGreaterThan(0);
 }finally{view.destroy();container.remove()}
}
it('installed toolbar partial bold',()=>toolbar('> Alpha Beta。\n',8,12,{kind:'bold'},'> Alpha **Beta**。\n'));
it('installed toolbar cross paragraphs',()=>{const b=createSourceSession('Alpha。\n\nBeta。\n');if(!b.ok)throw Error(b.reason);expect(b.session.doc.textBetween(1,13,'\n')).toBe('Alpha。\nBeta');toolbar('Alpha。\n\nBeta。\n',1,13,{kind:'bold'},'**Alpha。**\n\n**Beta**。\n')});
it('installed toolbar inserts text plus link',()=>toolbar('Keep。\n',1,1,{kind:'link',href:'/u',text:'A'},'[A](/u)Keep。\n'));
import {createEditor} from '@moraya/core';
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver';
import type {Node as PmNode} from 'prosemirror-model';
function at(doc:PmNode,path:readonly number[],offset=0){let n=doc,p=0;for(const i of path){for(let j=0;j<i;j++)p+=n.child(j).nodeSize;p++;n=n.child(i)}return p+offset}
it('installed toolbar spans real table cells',()=>{
 const raw='| H | J |\n| :--- | ---: |\n|  Alpha | Beta  |\n',b=createSourceSession(raw);if(!b.ok)throw Error(b.reason);
 toolbar(raw,at(b.session.doc,[0,1,0,0]),at(b.session.doc,[0,1,1,0],4),{kind:'bold'},'| H | J |\n| :--- | ---: |\n|  **Alpha** | **Beta**  |\n');
});
it.each([
 ['', [0],{kind:'bold'},'**X**','**X\u200b**'],
 ['>\n',[0,0],{kind:'italic'},'>*X*\n','>*X\u200b*\n'],
 ['| H | J |\n| --- | --- |\n| A |   |\n',[0,1,1,0],{kind:'bold'},'| H | J |\n| --- | --- |\n| A |**X**   |\n','| H | J |\n| --- | --- |\n| A |**X\u200b**   |\n'],
 ['', [0],{kind:'link',href:'/u',text:'X'},'[X](/u)','\\[X\\](/u)'],
 ['A\n\n\nB',[1],{kind:'link',href:'/u',text:'X'},'A\n\n[X](/u)\n\nB','A\n\n\\[X\\](/u)\n\nB'],
 ['| H | J |\n| --- | --- |\n| A |\n',[0,1,1,0],{kind:'link',href:'/u',text:'X'},'| H | J |\n| --- | --- |\n| A |[X](/u)|\n','| H | J |\n| --- | --- |\n| A |\\[X\\](/u)|\n'],
 ['- # H\n',[0,0,0],{kind:'bold'},'- **X**\n  # H\n','- **X\u200b**\n  # H\n'],
 ['> A',[0,0],{kind:'bold'},'> A\n>\n>**X**','> A\n>\n>**X\u200b**'],
] as const)('installed empty toolbar session chain %j',async(raw,path,action,expected,appendedExpected)=>{
 const container=document.createElement('div');document.body.append(container);
 const editor=await createEditor({container,initialContent:raw,mediaResolver:new BrowserMediaResolver()});
 try{
  const opened=createSourceSession(raw,editor.view.state.schema);if(!opened.ok)throw Error(opened.reason);let base=opened.session;
  const p=at(base.doc,path,raw==='> A'?1:0);
  editor.view.updateState(EditorState.create({doc:base.doc,plugins:editor.view.state.plugins,selection:TextSelection.create(base.doc,p)}));
  expect(editor.view.state.plugins.length).toBeGreaterThan(0);
  const steps:number[]=[],commandSources:string[]=[],appendedSteps:number[]=[];
  editor.view.setProps({dispatchTransaction(tr){
   const applied=editor.view.state.applyTransaction(tr);expect(applied.transactions[0]).toBe(tr);steps.push(tr.steps.length);
   for(const actual of applied.transactions){
    const r=applySourceBlockTransaction(base,actual);expect(r.ok,r.ok?undefined:r.reason).toBe(true);if(!r.ok)throw Error(r.reason);
    expect(r.session.doc.eq(actual.doc)).toBe(true);base=r.session;
    if(actual===tr)commandSources.push(base.source);else appendedSteps.push(actual.steps.length);
   }
   editor.view.updateState(applied.state);expect(base.doc.eq(editor.view.state.doc)).toBe(true);
  }});
  if(raw==='> A'){let handled=false;editor.view.someProp('handleKeyDown',f=>{if(f(editor.view,new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))){handled=true;return true}return false});expect(handled).toBe(true);expect(base.source).toBe('> A\n>');steps.length=0}
  expect(executeEditorCommand(editor.view,action)).toBe(true);
  if(action.kind!=='link'){expect(base.source).toBe(raw==='> A'?'> A\n>':raw);editor.view.dispatch(editor.view.state.tr.insertText('X'));expect(steps).toEqual([0,1])}else expect(steps).toEqual([2]);
  expect(commandSources.at(-1)).toBe(expected);expect(appendedSteps).toEqual([1]);expect(base.source).toBe(appendedExpected);expect(base.doc.eq(editor.view.state.doc)).toBe(true);
 }finally{editor.destroy();container.remove()}
});
it('installed code single character yields one source patch and one proposal hunk',()=>{
 const raw='> ``甲`乙`` _Keep_\n',b=createSourceSession(raw);if(!b.ok)throw Error(b.reason);
 const tr=EditorState.create({doc:b.session.doc}).tr.insertText('丙',2,3),r=applySourceBlockTransaction(b.session,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe('> ``丙`乙`` _Keep_\n');expect(r.edits).toEqual([{from:4,to:5,text:'丙'}]);
 const p=propose({path:'inline.md',base:raw,ours:raw,theirs:r.session.source});expect(p.hunks).toHaveLength(1);expect(p.theirsEolAligned).toBe(false);
});
