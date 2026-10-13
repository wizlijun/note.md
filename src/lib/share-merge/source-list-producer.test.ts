import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import {createSourceSession,applySourceBlockTransaction,applySourceTextTransaction,parseMarkdown,serializeMarkdown} from '@moraya/core'
import {propose} from './index'

function open(source:string){
 const r=createSourceSession(source)
 expect(r.ok,r.ok?'captured':r.reason).toBe(true)
 if(!r.ok)throw Error(r.reason)
 return r.session
}
it.each([
 ['- - A',['-','-']],['> + A\n>   1) B\n>      * C',['+',')','*']],
 ['0. A',['.']],['8) A',[')']],['-\n-',['-']],
 ['\uFEFF+ A\r\n  * B\r\n',['+','*']],['> - A\r>   + B',['-','+']],
] as const)('installed committed API binds actual list nodes: %s',(source,markers)=>{
 const b=open(source),facts=b.layout.lists
 expect(facts?.map(f=>f.marker)).toEqual(markers);expect(Object.isFrozen(facts)).toBe(true)
 const positions:number[]=[];b.doc.descendants((n,p)=>{if(n.type.name.endsWith('_list'))positions.push(p)})
 expect(facts?.map(f=>f.pmFrom)).toEqual(positions)
 for(const f of facts!){
  const n=b.doc.nodeAt(f.pmFrom)!,root=b.roots.find(r=>r.id===f.rootId)!
  expect(n.type.name).toBe(f.kind+'_list');expect(n.nodeSize).toBe(f.pmTo-f.pmFrom)
  expect(f.pmFrom).toBeGreaterThanOrEqual(root.pmFrom);expect(f.pmTo).toBeLessThanOrEqual(root.pmTo)
  expect(source.slice(f.sourceFrom,f.sourceTo)).toContain(f.marker);expect(Object.isFrozen(f)).toBe(true)
 }
 expect(b.source).toBe(source)
})
it.each([0,1,3,8,999999999])('installed ordered %s survives default serialization',order=>{
 const b=open(`${order}. A`)
 expect(b.doc.child(0).attrs.order).toBe(order)
 const raw=serializeMarkdown(b.doc);expect(raw.startsWith(`${order}. `)).toBe(true)
 expect(parseMarkdown(raw).eq(b.doc)).toBe(true)
})
it.each(['- [x] A','+ [ ] B','* [X] C','- Outer\n  - [ ] B','- [x] &amp; \\* **bold** [link](https://example.com)'])(
 'installed checked source preserves complete attrs: %s',source=>{
  const b=open(source);expect(b.doc.eq(parseMarkdown(source))).toBe(true)
  expect(parseMarkdown(serializeMarkdown(b.doc)).eq(b.doc)).toBe(true)
  expect(b.textSpans).toEqual([]);expect(b.source).toBe(source)
 })
it('installed checkbox text edit preserves raw neighbors and strict target attrs',()=>{
 const source='\uFEFFBefore __raw__\r\n\r\n- [x] A\r\n\r\nTail _raw_',b=open(source)
 let at=-1;b.doc.descendants((n,p)=>{if(n.isText&&n.text==='A')at=p})
 expect(at).toBeGreaterThan(0)
 const tr=EditorState.create({doc:b.doc}).tr.insertText('B',at,at+1)
 expect(applySourceTextTransaction(b,tr).ok).toBe(false)
 const r=applySourceBlockTransaction(b,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(r.session.source).toBe(source.replace('- [x] A','- [x] B'))
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(open(r.session.source).doc.eq(tr.doc)).toBe(true)
 expect(r.changedRoots).toEqual([1]);expect(b.source).toBe(source)
})
it('unchanged nested list bytes survive a one-character proposal as one hunk',()=>{
 const prefix='\uFEFF> + [X] Same\r\n>   1) Same\r\n\r\n',source=prefix+'这是甲句。中间句保持。',b=open(source)
 const raw=source.indexOf('甲'),span=b.textSpans.find(s=>s.sourceFrom<=raw&&raw<s.sourceTo)!
 const at=span.pmFrom+raw-span.sourceFrom,tr=EditorState.create({doc:b.doc}).tr.insertText('乙',at,at+1)
 const r=applySourceTextTransaction(b,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(r.session.source).toBe(source.replace('甲','乙'));expect(r.session.source.startsWith(prefix)).toBe(true)
 expect(r.session.doc.eq(tr.doc)).toBe(true)
 const proposal=propose({path:'list.md',base:source,ours:source,theirs:r.session.source})
 expect(proposal.hunks).toHaveLength(1);expect(proposal.hunks[0]!.base).toBe('这是甲句。');expect(proposal.hunks[0]!.theirs).toBe('这是乙句。')
})

it.each([
 ['* outer\n  + A\n\n  + B\n* end','* outer\n  + Z\n\n  + B\n* end'],
 ['0) outer\n\n   3. A\n   4. B\n\n1) end','0) outer\n\n   3. Z\n   4. B\n\n1) end'],
] as const)('installed source-only marker and opposite tight styles %s',(raw,expected)=>{
 const suffix='\r\n \t\r\nTail __raw__',b=open(raw+suffix);let at=-1;b.doc.descendants((n,p)=>{if(n.isText&&n.text==='A')at=p})
 const tr=EditorState.create({doc:b.doc}).tr.insertText('Z',at,at+1),r=applySourceBlockTransaction(b,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(r.session.source).toBe(expected+suffix);expect(r.session.doc.eq(tr.doc)).toBe(true)
 expect(open(r.session.source).doc.eq(tr.doc)).toBe(true)
})
it('installed legacy metadata clone recaptures before rendering and keeps unchanged caller identity',()=>{
 const b=open('* A\n\n* B'),foreign={...b,roots:b.roots.map(root=>({...root})),layout:{blankLines:b.layout.blankLines}},tr=EditorState.create({doc:foreign.doc}).tr.insertText('Z',3,4)
 const r=applySourceBlockTransaction(foreign,tr);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(r.session.source).toBe('* Z\n\n* B');expect(r.session.doc.eq(tr.doc)).toBe(true)
 const unchanged=applySourceBlockTransaction(foreign,EditorState.create({doc:foreign.doc}).tr);expect(unchanged.ok&&unchanged.session).toBe(foreign)
})
