import {expect,it} from 'vitest'
import {createSchema,createSourceSession,prepareFileSourceEdits} from '@moraya/core'
import {withBlockIdentitySchema} from './identity'
import {nextBindings,projectBindings,validateBindings,restoreRecovery,restoreBindings} from './file-bindings'
import {neutralize} from './file-projection'
import {sha256Sync} from '../lib/share-merge/hash'
const schema=withBlockIdentitySchema(createSchema({mediaResolver:{loadLocalImage:async path=>path,loadLocalMedia:async path=>path,loadRemoteMedia:async url=>url}}))
function open(raw:string){const r=createSourceSession(raw,schema);if(!r.ok)throw Error(r.reason);return r.session}
it('projection covers actual roots and preserves synthetic children',()=>{
 const session=open('A\n\n\nB'),rows=session.roots.map((r)=>({rootOrdinal:r.id,id:'b'+r.id})),doc=projectBindings(session,rows)
 expect(doc.childCount).toBe(session.doc.childCount);expect(doc.firstChild!.attrs.cdrBlockId).toBe('b0')
 expect(neutralize(doc).eq(session.doc)).toBe(true)
 expect(validateBindings(session,[...rows,rows[0]])).toMatchObject({ok:false})
})
it('real retained source update inherits the old ID',()=>{
 const session=open('Alpha'),bindings=[{rootOrdinal:0,id:'old'}],next=prepareFileSourceEdits(session,{expectedRevision:session.revision,edits:[{from:0,to:1,removed:'A',text:'a'}]})
 expect(next.ok).toBe(true);if(!next.ok)throw Error(next.reason)
 expect(nextBindings({session,bindings},next.session,next.file.correspondence,()=> 'fresh')).toEqual({ok:true,bindings})
})
it('recovery hash mismatch discards only cached bindings',()=>{
 const session=open('A'),r=restoreRecovery(session,{v:1,sourceHash:sha256Sync('B'),sourceRevision:99,bindings:[{rootOrdinal:0,id:'old'}]},()=> 'fresh')
 expect(r).toEqual({ok:true,bindings:[{rootOrdinal:0,id:'fresh'}]});expect(session.source).toBe('A');expect(session.revision).toBe(0)
})
it.each(['','[ref]: /url','\n\n'])('zero roots accept only empty bindings, including actual fallback %j',raw=>{
 const session=open(raw);expect(session.roots).toHaveLength(0)
 expect(validateBindings(session,[])).toEqual({ok:true});expect(validateBindings(session,[{rootOrdinal:0,id:'x'}]).ok).toBe(false)
 const doc=projectBindings(session,[]);expect(doc.eq(session.doc)).toBe(true)
})
it('public shape contract: one root covers multiple actual children (not a parser/F1 fixture)',()=>{
 const captured=open('A\n\nB'),session={...captured,roots:[{...captured.roots[0],sourceTo:captured.source.length,tailFrom:captured.source.length,childTo:captured.doc.childCount,pmTo:captured.doc.content.size}]},rows=[{rootOrdinal:0,id:'r0'}]
 expect(session.roots.some(r=>r.childTo-r.childFrom>1)).toBe(true)
 const doc=projectBindings(session,rows)
 for(const root of session.roots)for(let i=root.childFrom;i<root.childTo;i++)expect(doc.child(i).attrs.cdrBlockId).toBe(rows[root.id].id)
 expect(neutralize(doc).eq(session.doc)).toBe(true)
})
function update(raw:string,from:number,to:number,text:string){
 const session=open(raw),bindings=session.roots.map(r=>({rootOrdinal:r.id,id:'old'+r.id})),r=prepareFileSourceEdits(session,{expectedRevision:session.revision,edits:[{from,to,removed:raw.slice(from,to),text}]})
 expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 let n=0;return {session,bindings,next:r.session,correspondence:r.file.correspondence,result:nextBindings({session,bindings},r.session,r.file.correspondence,()=> 'new'+n++)}
}
it('same-text siblings retain distinct identities through real F1 birth',()=>{
 const r=update('Same\n\nSame',6,6,'New\n\n')
 expect(r.result).toEqual({ok:true,bindings:[{rootOrdinal:0,id:'old0'},{rootOrdinal:1,id:'new0'},{rootOrdinal:2,id:'old1'}]})
})
it('real F1 split and join inherit the first root in source order',()=>{
 const split=update('AlphaBeta',5,5,'\n\n')
 expect(split.correspondence[0].kind).toBe('split')
 expect(split.result).toEqual({ok:true,bindings:[{rootOrdinal:0,id:'old0'},{rootOrdinal:1,id:'new0'}]})
 const join=update('Alpha\n\nBeta',5,7,' ')
 expect(join.correspondence[0].kind).toBe('join');expect(join.result).toEqual({ok:true,bindings:[{rootOrdinal:0,id:'old0'}]})
})
it('real full repartition never matches duplicate text to old IDs; deletion removes IDs',()=>{
 const r=update('Same\n\nSame',0,10,'Same\n\nDifferent\n\nSame')
 expect(r.correspondence[0].kind).toBe('repartition')
 expect(r.result).toEqual({ok:true,bindings:[{rootOrdinal:0,id:'new0'},{rootOrdinal:1,id:'new1'},{rootOrdinal:2,id:'new2'}]})
 const deleted=update('A\n\nB',0,3,'');expect(deleted.result).toEqual({ok:true,bindings:[{rootOrdinal:0,id:'old1'}]})
})
it('rejects incomplete/duplicate/out-of-range correspondence and fresh ID collisions',()=>{
 const r=update('Alpha',0,1,'a'),base={session:r.session,bindings:r.bindings}
 for(const correspondence of [[],[...r.correspondence,...r.correspondence],[{kind:'retained' as const,beforeRoots:[0],afterRoots:[1]}],[{kind:'split' as const,beforeRoots:[0],afterRoots:[0]}]])
  expect(nextBindings(base,r.next,correspondence,()=> 'x').ok).toBe(false)
 const split=update('AB',1,1,'\n\n')
 expect(nextBindings({session:split.session,bindings:split.bindings},split.next,split.correspondence,()=> 'old0').ok).toBe(false)
})
it('history restores exact IDs and rejects stale hash/current rows/after coverage',()=>{
 const r=update('AB',1,1,'\n\n');if(!r.result.ok)throw Error(r.result.reason)
 const transition={before:{sourceHash:sha256Sync(r.next.source),roots:r.result.bindings},after:{sourceHash:sha256Sync(r.session.source),roots:r.bindings}}
 expect(restoreBindings({session:r.next,bindings:r.result.bindings},r.session,transition)).toEqual({ok:true,bindings:r.bindings})
 expect(restoreBindings({session:r.next,bindings:r.result.bindings},r.session,{...transition,before:{...transition.before,sourceHash:'0'.repeat(64)}}).ok).toBe(false)
 expect(restoreBindings({session:r.next,bindings:r.result.bindings},r.session,{...transition,after:{...transition.after,roots:[]}}).ok).toBe(false)
 const changed=r.result.bindings.map(row=>({...row,id:row.id+'x'}))
 expect(restoreBindings({session:r.next,bindings:changed},r.session,transition).ok).toBe(false)
})
it('recovery preserves validated IDs without restoring an old core revision',()=>{
 const session=open('A'),bindings=[{rootOrdinal:0,id:'cached'}]
 expect(restoreRecovery(session,{v:1,sourceHash:sha256Sync('A'),sourceRevision:500,bindings},()=>{throw Error('no new ID')})).toEqual({ok:true,bindings})
 expect(session.revision).toBe(0)
 expect(restoreRecovery(session,{v:1,sourceHash:sha256Sync('A'),sourceRevision:1,bindings:[]},()=> 'fresh')).toEqual({ok:true,bindings:[{rootOrdinal:0,id:'fresh'}]})
})
it('invalid ownership and rows cannot mutate or partially project a document',()=>{
 const session=open('A\n\nB'),rows=session.roots.map(r=>({rootOrdinal:r.id,id:'b'+r.id})),before=session.doc.toJSON()
 for(const invalid of [[...rows.slice(0,1)],rows.map(r=>({...r,id:'same'})),new Array(2)]){
  expect(validateBindings(session,invalid).ok).toBe(false);expect(()=>projectBindings(session,invalid)).toThrow()
 }
 expect(validateBindings({...session,roots:session.roots.map((r,i)=>i? r:{...r,pmTo:r.pmTo+1})},rows).ok).toBe(false)
 expect(validateBindings({...session,roots:session.roots.slice(0,1)},rows.slice(0,1)).ok).toBe(false)
 expect(session.doc.toJSON()).toEqual(before)
})
