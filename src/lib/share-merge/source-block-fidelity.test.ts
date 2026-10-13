import {expect,it} from 'vitest'
import {EditorState} from 'prosemirror-state'
import {Slice} from 'prosemirror-model'
import {createSchema,createSourceSession,applySourceBlockTransaction} from '@moraya/core'
import {materializeBlocks} from '../../editor-kit-v2/block-layout'
import {withBlockIdentitySchema,withoutBlockIdentity} from '../../editor-kit-v2/identity'
import {propose} from './proposal'
function position(doc:any,needle:string) {
 let result:number|undefined
 doc.descendants((n:any,p:number)=>{if(n.isText&&result===undefined){const i=n.text.indexOf(needle);if(i>=0)result=p+i}})
 if(result===undefined)throw new Error('fixture text missing')
 return result
}
it('installed exact text output remains one sentence hunk',()=>{
 const source='首段不动。\r\n\r\n目标甲。第二句保持 __原样__。\r\n'
 const opened=createSourceSession(source);expect(opened.ok).toBe(true)
 if(!opened.ok)throw new Error(opened.reason)
 const b=opened.session,p=position(b.doc,'甲')
 const r=applySourceBlockTransaction(b,EditorState.create({doc:b.doc}).tr.insertText('乙',p,p+1))
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.mode).toBe('exact-text')
 expect(Buffer.from(r.session.source)).toEqual(Buffer.from(source.replace('甲','乙')))
 const proposal=propose({path:'a.md',base:source,ours:source,theirs:r.session.source})
 expect(proposal.theirsEolAligned).toBe(false);expect(proposal.hunks).toHaveLength(1)
 const h=proposal.hunks[0]!
 expect(h.kind).toBe('theirs-only');expect(h.base).toBe('目标甲。');expect(h.theirs).toBe('目标乙。')
 expect(h.oursStart).toBe(source.indexOf('目标甲。'));expect(h.oursEnd).toBe(h.oursStart+'目标甲。'.length)
})
it('one governed span with multiple PM roots only rewrites its changed natural root',()=>{
 const raw='First __raw__\r\n\r\nTarget\r\n\r\nLast *raw*\r\n'
 const schema=withBlockIdentitySchema(createSchema({mediaResolver:{
  loadLocalImage:async p=>p,loadLocalMedia:async p=>p,loadRemoteMedia:async p=>p,
 }}))
 const initial=materializeBlocks([{blockId:'one-governed-span',markdown:raw}],schema)
 expect(initial.layout.spans).toEqual([{blockId:'one-governed-span',startIndex:0,endIndex:3}])
 const opened=createSourceSession(raw,schema);expect(opened.ok).toBe(true)
 if(!opened.ok)throw new Error(opened.reason)
 const b=opened.session
 // Existing identity adapter neutralizes only cdrBlockId, not formatting attrs.
 const content=initial.doc.copy(withoutBlockIdentity(new Slice(initial.doc.content,0,0)).content)
 expect(content.eq(b.doc)).toBe(true)
 const p=position(b.doc,'Target')
 const tr=EditorState.create({doc:b.doc}).tr.addMark(p,p+6,schema.marks.strong!.create())
 const r=applySourceBlockTransaction(b,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.changedRoots).toEqual([1]);expect(r.edits).toHaveLength(1)
 expect(r.session.source).toBe('First __raw__\r\n\r\n**Target**\r\n\r\nLast *raw*\r\n')
 const kernel=propose({path:'governed.md',base:raw,ours:raw,theirs:r.session.source})
 expect(kernel.theirsEolAligned).toBe(false)
 expect(kernel.hunks).toHaveLength(1)
 expect(kernel.hunks[0]!.base).toBe('Target\r\n')
 expect(kernel.hunks[0]!.theirs).toBe('**Target**\r\n')
})
it('installed fallback keeps table-adjacent root and separator bytes',()=>{
 const raw='| A |\n| --- |\n| Target |\n\nTail __raw__\r\n'
 const opened=createSourceSession(raw);expect(opened.ok).toBe(true)
 if(!opened.ok)throw new Error(opened.reason)
 const b=opened.session,p=position(b.doc,'Target')
 const r=applySourceBlockTransaction(b,EditorState.create({doc:b.doc}).tr.addMark(p,p+6,b.doc.type.schema.marks.strong!.create()))
 expect(r.ok).toBe(true);if(!r.ok)throw new Error(r.reason)
 expect(r.changedRoots).toEqual([0]);expect(r.edits).toHaveLength(1)
 expect(r.session.source.endsWith('\n\nTail __raw__\r\n')).toBe(true)
 const proposal=propose({path:'table.md',base:raw,ours:raw,theirs:r.session.source})
 expect(proposal.theirsEolAligned).toBe(false)
 for(const h of proposal.hunks){expect(h.oursEnd).toBeLessThanOrEqual(raw.indexOf('\n\nTail')+1)}
 // Canonical formatting inside the actually changed table can create several hunks.
 expect(proposal.hunks.length).toBeGreaterThan(0)
})

for(const source of ['- [ref]: /url\n\n  Alpha\n\nTail','> [ref]: /url\n>\n> Alpha\n\nTail']) {
 it(`rejects rendering a reference-covered owner atomically: ${JSON.stringify(source)}`,()=>{
  const opened=createSourceSession(source);expect(opened.ok).toBe(true)
  if(!opened.ok)throw new Error(opened.reason)
  const base=opened.session,p=position(base.doc,'Alpha')
  const before=JSON.stringify(base),bytes=Buffer.from(base.source)
  const tr=EditorState.create({doc:base.doc}).tr.addMark(p,p+5,base.doc.type.schema.marks.strong!.create())
  const result=applySourceBlockTransaction(base,tr)
  expect(result).toEqual({ok:false,reason:'unsupported-step'})
  expect(result).not.toHaveProperty('session')
  expect(Buffer.from(base.source)).toEqual(bytes)
  expect(JSON.stringify(base)).toBe(before)
 })
}

for(const source of ['- [ref]: /url\r\n\r\n  Alpha\r\n\r\nTail','> [ref]: /url\r\n>\r\n> Alpha\r\n\r\nTail']) {
 it(`installed adjacent exact/render edits retain reference bytes: ${JSON.stringify(source)}`,()=>{
  const opened=createSourceSession(source);expect(opened.ok).toBe(true)
  if(!opened.ok)throw new Error(opened.reason)
  const base=opened.session,p=position(base.doc,'Tail')
  expect(base.protectedSources).toEqual([{kind:'reference-definition',sourceFrom:0,sourceTo:'- [ref]: /url\r\n'.length,scope:'nested'}])
  const state=EditorState.create({doc:base.doc})
  for(const [tr,tail] of [[state.tr.insertText('S',p,p+1),'Sail'],
   [state.tr.addMark(p,p+4,base.doc.type.schema.marks.strong!.create()),'**Tail**']] as const) {
   const result=applySourceBlockTransaction(base,tr)
   expect(result.ok).toBe(true)
   if(!result.ok)throw new Error(result.reason)
   expect(Buffer.from(result.session.source)).toEqual(Buffer.from(source.replace('Tail',tail)))
   expect(result.session.protectedSources).toEqual(base.protectedSources)
  }
 })
}
