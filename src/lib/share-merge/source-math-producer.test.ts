// @vitest-environment happy-dom
import {it,expect} from 'vitest';
import {EditorState,TextSelection,type Transaction} from 'prosemirror-state';
import {EditorView} from 'prosemirror-view';
import {ReplaceStep,ReplaceAroundStep} from 'prosemirror-transform';
import {createSourceSession,createSchema,applySourceBlockTransaction,createEditor,insertMathBlock as rootCommand} from '@moraya/core';
import {insertMathBlock as subpathCommand} from '@moraya/core/commands';
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver';
import {insertAtom} from '../context-menu/block-helpers';
import {getSlashItems} from '../slash-menu/slash-items';

it.each([['root',rootCommand],['commands',subpathCommand]] as const)('installed %s command uses the actual state schema',(_name,command)=>{
 for(const schema of [undefined,createSchema({mediaResolver:new BrowserMediaResolver()})]){
  const o=createSourceSession('',schema);if(!o.ok)throw Error(o.reason);const b=o.session,state=EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,1)});let tr:Transaction|undefined;
  expect(command(state,t=>{tr=t})).toBe(true);if(!tr)throw Error('dispatch');
  expect(tr.steps).toHaveLength(1);expect(Object.getPrototypeOf(tr.steps[0]!)).toBe(ReplaceStep.prototype);
  expect(tr.doc.firstChild!.type).toBe(state.schema.nodes.math_block);expect(tr.doc.firstChild!.attrs.value).toBe('');expect(tr.doc.eq(b.doc)).toBe(false);
  const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);expect(r.session.source).toBe('$$ $$');expect(r.session.doc.eq(tr.doc)).toBe(true);
 }
});
for(const action of ['insertAtom','slash'] as const)it.each([
 ['',1,'$$ $$'],
 ['A __Keep__ B\n',2,'A\n\n$$ $$\n\n&#32;**Keep** B\n'],
 ['> __Keep__ AB\n',8,'> **Keep** A\n>\n> $$ $$\n>\n> B\n'],
] as const)(`installed ${action} saves actual block transaction: %j`,async(raw,at,expected)=>{
 const schema=createSchema({mediaResolver:new BrowserMediaResolver()}),o=createSourceSession(raw,schema);if(!o.ok)throw Error(o.reason);const b=o.session,container=document.createElement('div');document.body.append(container);
 const seen:Transaction[]=[];const view=new EditorView(container,{state:EditorState.create({doc:b.doc,selection:TextSelection.create(b.doc,at)}),dispatchTransaction(tr){seen.push(tr);view.updateState(view.state.apply(tr))}});
 try{
  if(action==='insertAtom')insertAtom(view,'math_block',{value:''});else{const item=getSlashItems().find(x=>x.id==='math');expect(item).toBeDefined();await item!.execute(view)}
  expect(seen).toHaveLength(1);const tr=seen[0]!,r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
  expect(r.session.source).toBe(expected);expect(r.session.doc.eq(tr.doc)).toBe(true);expect(b.source).toBe(raw);
 }finally{view.destroy();container.remove()}
});
it.each([
 ['$$',[0],2,' ','$$ $$'],
 ['> $$',[0,0],2,' ','> $$ $$'],
 ['__Keep__ $x',[0],7,'$','__Keep__ $x$'],
 ['> __Keep__ $x$ $$x$$ $z\r\n',[0,0],15,'$','> __Keep__ $x$ $$x$$ $z$\r\n'],
 ['| H |\n| --- |\n| __Keep__ $a\\|b |\n',[0,1,0,0],9,'$','| H |\n| --- |\n| __Keep__ $a\\|b$ |\n'],
 ['> [r]: /u\n>\n> __Keep__ $x\n',[0,0],7,'$','> [r]: /u\n>\n> __Keep__ $x$\n'],
] as const)('installed real math InputRule retains original steps and source: %j',async(raw,path,offset,text,expected)=>{
 const container=document.createElement('div');document.body.append(container);const editor=await createEditor({container,initialContent:raw,mediaResolver:new BrowserMediaResolver()});
 try{
  const o=createSourceSession(raw,editor.view.state.schema);if(!o.ok)throw Error(o.reason);const b=o.session;let at=0,node=b.doc;
  for(const i of path){for(let j=0;j<i;j++)at+=node.child(j).nodeSize;at++;node=node.child(i)}at+=offset;
  editor.view.updateState(EditorState.create({doc:b.doc,plugins:editor.view.state.plugins,selection:TextSelection.create(b.doc,at)}));
  const seen:Transaction[]=[];editor.view.setProps({dispatchTransaction(tr){seen.push(tr);editor.view.updateState(editor.view.state.apply(tr))}});
  expect(editor.view.someProp('handleTextInput',f=>f(editor.view,at,at,text,()=>editor.view.state.tr.insertText(text,at)))).toBe(true);expect(seen).toHaveLength(1);
  const tr=seen[0]!;expect(tr.steps.map(s=>Object.getPrototypeOf(s))).toEqual(text===' '?[ReplaceStep.prototype,ReplaceAroundStep.prototype]:[ReplaceStep.prototype]);
  const r=applySourceBlockTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);expect(r.session.source).toBe(expected);expect(r.session.doc.eq(tr.doc)).toBe(true);expect(b.source).toBe(raw);
  if(text==='$'){
   expect(r.mode).toBe('fragment-render');expect(r.edits.every(e=>!b.source.slice(e.from,e.to).includes('__Keep__'))).toBe(true);
   const next=applySourceBlockTransaction(r.session,EditorState.create({doc:r.session.doc}).tr.insertText('Z',at-offset,at-offset+1));expect(next.ok).toBe(true);if(next.ok)expect(next.session.source).toBe(expected.replace('__Keep__','__Zeep__'));
  }
 }finally{editor.destroy();container.remove()}
});
