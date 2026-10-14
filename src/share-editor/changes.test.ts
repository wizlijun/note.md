import { expect, it } from 'vitest'
import { extractGuestAnnotations, propose } from '../lib/share-merge'
import { revertGuestHunk } from './changes'
const base='第一句。\n\n第二句。\n', draft='第一句！\n\n第二句！\n'
it('reverts only the current selected hunk and preserves the independently constructed other edit',()=> {
 const p=propose({path:'a.md',base,ours:base,theirs:draft})
 expect(p.hunks).toHaveLength(2)
 expect(revertGuestHunk({path:'a.md',base,draft,hunkId:p.hunks[0].id})).toBe('第一句。\n\n第二句！\n')
})
it('rejects a stale hunk id instead of replaying old offsets',()=> {
 const p=propose({path:'a.md',base,ours:base,theirs:draft})
 expect(()=>revertGuestHunk({path:'a.md',base,draft:base,hunkId:p.hunks[0].id})).toThrow()
})
it('keeps guest annotations and raw whitespace on the unaffected change',()=> {
 const raw='第一句！\n\n{==第二句==}{>>保留批注<<}！\n'
 const p=propose({path:'a.md',base,ours:base,theirs:extractGuestAnnotations({base,draft:raw}).clean})
 expect(revertGuestHunk({path:'a.md',base,draft:raw,hunkId:p.hunks[0].id})).toBe('第一句。\n\n{==第二句==}{>>保留批注<<}！\n')
})
it('rejects a revert that would orphan an annotation, retaining the entire original draft',()=> {
 const raw='{==第一句！==}{>>不能丢<<}\n\n第二句！\n'
 const p=propose({path:'a.md',base,ours:base,theirs:extractGuestAnnotations({base,draft:raw}).clean})
 expect(()=>revertGuestHunk({path:'a.md',base,draft:raw,hunkId:p.hunks[0].id})).toThrow(/批注/)
})
it('reverts deletion hunks even when there is no changed text to decorate',()=> {
 const original='A\n\nB\n\nC\n', removed='A\n\nC\n'
 const p=propose({path:'a.md',base:original,ours:original,theirs:removed})
 expect(revertGuestHunk({path:'a.md',base:original,draft:removed,hunkId:p.hunks[0].id})).toBe(original)
})
it('keeps untouched BOM, CRLF and absent final newline exactly',()=> {
 const original='\uFEFF第一句。\r\n\r\n第二句。', edited='\uFEFF第一句！\r\n\r\n第二句！'
 const p=propose({path:'a.md',base:original,ours:original,theirs:edited})
 expect(revertGuestHunk({path:'a.md',base:original,draft:edited,hunkId:p.hunks[0].id})).toBe('\uFEFF第一句。\r\n\r\n第二句！')
})
it('keeps duplicated owner markup and reanchors guest markup outside the reverted hunk',()=> {
 const original='A\n\n{==text==}{>>owner<<}\n', edited='B\n\n{==text==}{>>owner<<}{>>guest<<}\n'
 const p=propose({path:'a.md',base:original,ours:original,theirs:extractGuestAnnotations({base:original,draft:edited}).clean})
 expect(revertGuestHunk({path:'a.md',base:original,draft:edited,hunkId:p.hunks[0].id})).toBe('A\n\n{==text==}{>>owner<<}{>>guest<<}\n')
})
it('the owner proposal still flags forged owner annotation changes',()=> {
 const original='正文{>>分享者原注<<}\n', forged='正文{>>伪造的新注<<}\n'
 const extracted=extractGuestAnnotations({base:original,draft:forged})
 const p=propose({path:'a.md',base:original,ours:original,theirs:extracted.clean})
 expect(p.hunks.some(h=>h.flags.includes('owner-annotation'))).toBe(true)
 expect(extracted.ownerAnnotationsTouched).toEqual(['{>>分享者原注<<}'])
})
