import {expect,it} from 'vitest';
import {EditorState,TextSelection} from 'prosemirror-state';
import {ReplaceStep} from 'prosemirror-transform';
import type {Node as PmNode} from 'prosemirror-model';
import {createEditor,createSourceSession,applySourceBlockTransaction,type FrontmatterViewFactory,type SourceBlockResult} from '@moraya/core';
import {BrowserMediaResolver} from '@moraya/core/adapters/browser-media-resolver';
import {propose} from './proposal';
function at(doc:PmNode,path:readonly number[]){
 let n=doc,p=0;for(const i of path){for(let j=0;j<i;j++)p+=n.child(j).nodeSize;p++;n=n.child(i)}return p;
}
function open(raw:string){const r=createSourceSession(raw);if(!r.ok)throw Error(r.reason);return r.session}
// Task 1 writes this consumer; only Task 2's committed dist installation can validate it.
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
  editor.view.setProps({dispatchTransaction(tr){seen.push(applySourceBlockTransaction(b,tr));editor.view.updateState(editor.view.state.apply(tr))}});
  expect(input).toBeTypeOf('function');input!('a: X\nb: Y');
  expect(seen).toHaveLength(1);const r=seen[0]!;expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason);
  expect(r.session.source).toBe('---\r\na: X\r\nb: Y\r\n---\r\n');expect(r.session.doc.eq(editor.view.state.doc)).toBe(true);
  const proposal=propose({path:'frontmatter.md',base:raw,ours:raw,theirs:r.session.source});expect(proposal.hunks).toHaveLength(1);
 }finally{editor.destroy();container.remove()}
});
