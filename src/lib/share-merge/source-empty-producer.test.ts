// @vitest-environment happy-dom
import {expect,it} from 'vitest';
import {EditorState,TextSelection,type Transaction} from 'prosemirror-state';
import {ReplaceStep} from 'prosemirror-transform';
import type {Node as PmNode} from 'prosemirror-model';
import {createEditor,createSourceSession,applySourceBlockTransaction,type FrontmatterViewFactory,type SourceBlockResult} from '@moraya/core';
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver';
import {propose} from './proposal';
function at(doc:PmNode,path:readonly number[]){
 let n=doc,p=0;for(const i of path){for(let j=0;j<i;j++)p+=n.child(j).nodeSize;p++;n=n.child(i)}return p;
}
function open(raw:string){const r=createSourceSession(raw);if(!r.ok)throw Error(r.reason);return r.session}
it.each([
 ['', [0], 'X'],
 ['A\n\n\nB',[1],'A\n\nX\n\nB'],
 ['- [ ] \n',[0,0,0],'- [ ] X\n'],
 ['7)\r\n',[0,0,0],'7) X\r\n'],
 ['> >\n',[0,0,0],'> >X\n'],
 ['| H | J |\n| --- | --- |\n| A | |\n',[0,1,1,0],'| H | J |\n| --- | --- |\n| A |X |\n'],
 ['| H | J |\n| --- | --- |\n| A |\n',[0,1,1,0],'| H | J |\n| --- | --- |\n| A |X|\n'],
 ['- # H\n',[0,0,0],'- X\n  # H\n'],
 ['```js\r\n```\r\n',[0],'```js\r\nX\r\n```\r\n'],
] as const)('installed ordinary empty body %j',(raw,path,expected)=>{
 const b=open(raw),p=at(b.doc,path),state=EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,p)});
 expect(state.selection.$from.parent.content.size).toBe(0);
 const tr=state.tr.insertText('X');expect(tr.steps).toHaveLength(1);expect(Object.getPrototypeOf(tr.steps[0])).toBe(ReplaceStep.prototype);
 const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
 expect(r.session.source).toBe(expected);expect(r.session.doc.eq(tr.doc)).toBe(true);
 expect(b.source).toBe(raw);
 const proposal=propose({path:'body.md',base:raw,ours:raw,theirs:r.session.source});
 expect(proposal.hunks).toHaveLength(1);expect(proposal.hunks[0]!.kind).toBe('theirs-only');
});
it('installed real frontmatter NodeView first multiline input retains CRLF',async()=>{
 const raw='---\r\n---\r\n';let input:((value:string)=>void)|undefined;
 const factory:FrontmatterViewFactory={render(_container,_raw,onChange){input=onChange;return {destroy(){}}}};
 const container=document.createElement('div');document.body.append(container);
 const editor=await createEditor({container,mediaResolver:new BrowserMediaResolver(),frontmatterViewFactory:factory});
 try{
  const b=open(raw),seen:SourceBlockResult[]=[];
  // A fresh NodeView must receive the captured doc, not a legacy initialization callback.
  expect(input).toBeUndefined();
  editor.view.updateState(EditorState.create({doc:b.doc,plugins:editor.view.state.plugins}));
  expect(editor.view.state.doc.eq(b.doc)).toBe(true);
  editor.view.setProps({dispatchTransaction(tr){const result=applySourceBlockTransaction(b,tr);seen.push(result);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);expect(tr.steps).toHaveLength(1);const step=tr.steps[0] as ReplaceStep;expect(Object.getPrototypeOf(step)).toBe(ReplaceStep.prototype);expect(step.from).toBe(step.to);expect(tr.doc.firstChild!.attrs).toEqual(b.doc.firstChild!.attrs);editor.view.updateState(editor.view.state.apply(tr))}});
  expect(input).toBeTypeOf('function');input!('title: X');
  expect(seen).toHaveLength(1);const r=seen[0]!;expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
  expect(r.session.source).toBe('---\r\ntitle: X\r\n---\r\n');expect(r.session.doc.eq(editor.view.state.doc)).toBe(true);
  const proposal=propose({path:'frontmatter.md',base:raw,ours:raw,theirs:r.session.source});expect(proposal.hunks).toHaveLength(1);
 }finally{editor.destroy();container.remove()}
});

import type {EditorView} from 'prosemirror-view';
import {executeEditorCommand} from '../../editor-kit-v2/commands';
async function mounted(raw:string,path:readonly number[],offset:number,run:(view:EditorView,source:()=>string,changes:()=>readonly SourceBlockResult[])=>void){
 const container=document.createElement('div');document.body.append(container);
 const editor=await createEditor({container,initialContent:raw.startsWith('\uFEFF')?raw.slice(1):raw,mediaResolver:new BrowserMediaResolver()});
 try{
  const opened=createSourceSession(raw,editor.view.state.schema);if(!opened.ok)throw Error(opened.reason);
  let base=opened.session;const results:SourceBlockResult[]=[];
  editor.view.updateState(EditorState.create({doc:base.doc,plugins:editor.view.state.plugins,selection:TextSelection.create(base.doc,at(base.doc,path)+offset)}));
  expect(editor.view.state.plugins.length).toBeGreaterThan(0);
  editor.view.setProps({dispatchTransaction(tr:Transaction){
   const result=applySourceBlockTransaction(base,tr);expect(result.ok,result.ok?undefined:result.reason).toBe(true);if(!result.ok)throw Error(result.reason);
   expect(result.session.doc.eq(tr.doc)).toBe(true);base=result.session;results.push(result);
   editor.view.updateState(editor.view.state.apply(tr));
   const proposal=propose({path:'mounted.md',base:raw,ours:raw,theirs:base.source});
   expect(proposal.hunks.length).toBeGreaterThan(0);expect(proposal.hunks.every(h=>h.kind==='theirs-only')).toBe(true);
  }});
  run(editor.view,()=>base.source,()=>results);
 }finally{editor.destroy();container.remove()}
}
function enter(view:EditorView,modified=false){
 const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,ctrlKey:modified});let handled=false;
 view.someProp('handleKeyDown',fn=>{if(fn(view,event)){handled=true;return true}return false});expect(handled).toBe(true);
}
function firstText(view:EditorView,text='X'){
 expect(view.state.selection.$from.parent.content.size).toBe(0);view.dispatch(view.state.tr.insertText(text));
}
it.each([
 ['A',[0],1,'A\n\n','A\n\nX\n'],
 ['> A',[0,0],1,'> A\n>','> A\n>\n>X'],
 ['- A',[0,0,0],1,'- A\n- ','- A\n- X'],
] as const)('installed real Enter then first text %j',async(raw,path,offset,intermediate,expected)=>{
 await mounted(raw,path,offset,(view,source)=>{enter(view);expect(source()).toBe(intermediate);firstText(view);expect(source()).toBe(expected)});
});
it('installed quote survives two real Enter and input sessions',async()=>{
 await mounted('> A',[0,0],1,(view,source)=>{
  enter(view);expect(source()).toBe('> A\n>');firstText(view);expect(source()).toBe('> A\n>\n>X');
  enter(view);expect(source()).toBe('> A\n>\n> X\n>');firstText(view,'Y');expect(source()).toBe('> A\n>\n> X\n>\n>Y');
 });
});
it('installed second empty list Enter exits then accepts text',async()=>{
 await mounted('- A',[0,0,0],1,(view,source)=>{enter(view);expect(source()).toBe('- A\n- ');enter(view);expect(source()).toBe('- A\n\n');firstText(view);expect(source()).toBe('- A\n\nX\n')});
});
it('installed actual empty code Enter retains content LF and closing fence',async()=>{
 await mounted('```\n\n```',[0],0,(view,source)=>{
  enter(view);expect(source()).toBe('```\n\n\n```');expect(view.state.doc.firstChild!.textContent).toBe('\n');
  view.dispatch(view.state.tr.insertText('X'));expect(source()).toBe('```\n\nX\n```');
 });
});
it.each([
 ['blockquote','> ','> X'],['bullet-list','- ','- X'],['code-block','```\n\n```','```\nX\n```'],
] as const)('installed empty %s toolbar then first text',async(kind,intermediate,expected)=>{
 await mounted('',[0],0,(view,source)=>{expect(executeEditorCommand(view,{kind})).toBe(true);expect(source()).toBe(intermediate);firstText(view);expect(source()).toBe(expected)});
});
const table='| H | J |\n| --- | --- |\n| A | B |';
it('installed actual last-row Enter exits table then accepts first text',async()=>{
 await mounted(table,[0,1,1,0],1,(view,source)=>{enter(view);expect(source()).toBe(table+'\n\n');firstText(view);expect(source()).toBe(table+'\n\nX\n')});
});
it('installed actual Mod-Enter adds an empty row and types one narrow cell insertion',async()=>{
 await mounted(table,[0,1,0,0],1,(view,source,changes)=>{
  enter(view,true);expect(source()).toBe(table+'\n|  |  |');const before=source();firstText(view);
  expect(source()).toBe(table+'\n|X  |  |');const last=changes().at(-1)!;expect(last.ok).toBe(true);if(!last.ok)throw Error(last.reason);
  expect(last.edits).toEqual([{from:table.length+2,to:table.length+2,text:'X'}]);
  const proposal=propose({path:'cell.md',base:before,ours:before,theirs:source()});expect(proposal.hunks).toHaveLength(1);
 });
});

it.each([
 ['- \n  B',[0,0,0],'- X\n  \n  B'],
 ['[^e]:\n    B',[0,0],'[^e]:X\n    \n    B'],
 ['> - \n>   B',[0,0,0,0],'> - X\n>   \n>   B'],
] as const)('installed first marker paragraph uses its actual continuation prefix %j',async(raw,path,expected)=>{
 await mounted(raw,path,0,(view,source)=>{firstText(view);expect(source()).toBe(expected)});
});
