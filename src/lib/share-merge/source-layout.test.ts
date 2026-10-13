import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import {createSourceSession,applySourceBlockTransaction} from '@moraya/core'
import {propose} from './proposal'
function open(raw:string){const r=createSourceSession(raw);if(!r.ok)throw new Error(r.reason);return r.session}
it('installed layout keeps root-tail source and materializes a certified empty paragraph',()=>{
 const raw='- A\n\n\nB',s=open(raw),state=EditorState.create({doc:s.doc})
 expect(s.doc.childCount).toBe(3)
 expect(s.roots.map(r=>[r.childFrom,r.childTo])).toEqual([[0,1],[2,3]])
 expect(s.gaps.flatMap(g=>g.synthetic)).toEqual([])
 expect(s.layout.blankLines.map(u=>u.container.kind)).toEqual(['root-tail','root-tail'])
 const tr=state.tr.addMark(3,4,s.doc.type.schema.marks.strong!.create()),r=applySourceBlockTransaction(s,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.session.doc.eq(tr.doc)).toBe(true);expect(r.session.source).toBe('- **A**\n\n\nB')
 const input=state.tr.insertText('X',8),typed=applySourceBlockTransaction(s,input)
 expect(typed.ok).toBe(true);if(!typed.ok)throw new Error(typed.reason)
 expect(typed.session.doc.eq(input.doc)).toBe(true);expect(typed.session.source).toBe('- A\n\nX\n\nB')
 expect(typed.edits).toEqual([{from:5,to:5,text:'X'},{from:6,to:6,text:'\n'}])
})
it('installed exact edit with captured suffix layout remains one sentence hunk',()=>{
 const raw='首段不动。\r\n\r\n目标甲。第二句保持 __原样__。\r\n\r\n',s=open(raw)
 const rawPos=raw.indexOf('甲'),span=s.textSpans.find(x=>x.sourceFrom<=rawPos&&x.sourceTo>rawPos)!
 const p=span.pmFrom+rawPos-span.sourceFrom,tr=EditorState.create({doc:s.doc}).tr.insertText('乙',p,p+1)
 const r=applySourceBlockTransaction(s,tr);expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.mode).toBe('exact-text');expect(Buffer.from(r.session.source)).toEqual(Buffer.from(raw.replace('甲','乙')))
 const proposal=propose({path:'layout.md',base:raw,ours:raw,theirs:r.session.source})
 expect(proposal.theirsEolAligned).toBe(false);expect(proposal.hunks).toHaveLength(1)
 expect(proposal.hunks[0]!.base).toBe('目标甲。');expect(proposal.hunks[0]!.theirs).toBe('目标乙。')
})
it('installed terminal renderer preserves two atoms and unchanged reference suffix bytes',()=>{
 const raw='A\\\n\\\n\n[ref]: /url\n',s=open(raw)
 let count=0;s.doc.descendants(n=>{if(n.type.name==='hardbreak')count++});expect(count).toBe(2)
 const tr=EditorState.create({doc:s.doc}).tr.addMark(1,2,s.doc.type.schema.marks.strong!.create())
 const r=applySourceBlockTransaction(s,tr);expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.session.doc.eq(tr.doc)).toBe(true)
 expect(r.session.source.endsWith('\n\n[ref]: /url\n')).toBe(true)
 expect(r.session.protectedSources).toHaveLength(1)
})
