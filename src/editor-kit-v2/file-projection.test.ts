import {expect,it} from 'vitest'
import {createSchema,createSourceSession,applySourceBlockTransaction} from '@moraya/core'
import {EditorState} from 'prosemirror-state'
import {AttrStep,ReplaceStep} from 'prosemirror-transform'
import {Slice} from 'prosemirror-model'
import {withBlockIdentitySchema} from './identity'
import {projectBindings} from './file-bindings'
import {createFileProjection,neutralize} from './file-projection'
const schema=withBlockIdentitySchema(createSchema({mediaResolver:{loadLocalImage:async path=>path,loadLocalMedia:async path=>path,loadRemoteMedia:async url=>url}}))
function setup(raw:string){const r=createSourceSession(raw,schema);if(!r.ok)throw Error(r.reason);const session=r.session,bindings=session.roots.map(r=>({rootOrdinal:r.id,id:'b'+r.id}));return {base:{session,bindings},state:EditorState.create({doc:projectBindings(session,bindings)})}}
it('canonical replay preserves actual text change for F1 consumption',()=>{
 const {base,state}=setup('Alpha'),tr=state.tr.insertText('a',1,2),r=createFileProjection().project(base,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(r.transaction.steps).toHaveLength(1);expect(r.transaction.doc.textContent).toBe('alpha')
 expect(applySourceBlockTransaction(base.session,r.transaction).ok).toBe(true)
})
it('rejects unknown subclasses and unauthorized identity AttrSteps',()=>{
 const {base,state}=setup('A'),p=createFileProjection();class Foreign extends ReplaceStep{}
 expect(p.project(base,state.tr.step(new Foreign(1,1,Slice.empty)))).toMatchObject({ok:false})
 expect(p.project(base,state.tr.step(new AttrStep(0,'cdrBlockId','other')))).toMatchObject({ok:false})
})
import {AddMarkStep,RemoveMarkStep,ReplaceAroundStep,AddNodeMarkStep,RemoveNodeMarkStep,Step} from 'prosemirror-transform'
import {TextSelection,type Transaction} from 'prosemirror-state'
import {wrapInList} from 'prosemirror-schema-list'
import {prepareSourceListBoundarySteps} from '@moraya/core'
import {SourceHistoryStep,TableLayoutStep} from '@moraya/core/source-history'
import {nextBindings} from './file-bindings'
import {assertProjection} from './file-projection'
it('neutralization only clears schema-declared identity and preserves doc/text attrs and marks',()=>{
 const {base,state}=setup('> A'),doc=neutralize(state.doc)
 expect(doc.eq(base.session.doc)).toBe(true);expect(neutralize(state.doc)).toBe(doc)
 expect(Object.hasOwn(doc.attrs,'cdrBlockId')).toBe(false)
 let text=false;doc.descendants(n=>{if(n.isText){text=true;expect(Object.hasOwn(n.attrs,'cdrBlockId')).toBe(false)}});expect(text).toBe(true)
 const marked=state.doc.mark([schema.marks.strong.create()]);expect(()=>assertProjection(marked,base.session)).toThrow()
 const differentSchema=withBlockIdentitySchema(createSchema({mediaResolver:{loadLocalImage:async p=>p,loadLocalMedia:async p=>p,loadRemoteMedia:async p=>p}}))
 expect(()=>assertProjection(differentSchema.nodeFromJSON(state.doc.toJSON()),base.session)).toThrow()
})
it('preserves other attrs and wide mark ranges exactly',()=>{
 const {base,state}=setup('# A\n\nB'),p=createFileProjection(),tr=state.tr.step(new AttrStep(0,'level',2))
 const attr=p.project(base,tr);expect(attr.ok).toBe(true);if(!attr.ok)throw Error(attr.reason)
 expect(attr.transaction.doc.firstChild!.attrs.level).toBe(2)
 expect(attr.transaction.steps[0].toJSON()).toEqual(tr.steps[0].toJSON())
 const mark=state.tr.step(new AddMarkStep(1,state.doc.content.size-1,schema.marks.strong.create()))
 const r=p.project(base,mark);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(r.transaction.steps).toHaveLength(1);expect(r.transaction.steps[0].toJSON()).toEqual(mark.steps[0].toJSON())
 expect(applySourceBlockTransaction(base.session,r.transaction).ok).toBe(true)
})
it('real nested wrap and M producer replay without per-block sessions',()=>{
 const {base,state}=setup('> 1. A\n>\n> P\n>\n> 1. B'),p=createFileProjection();let position=-1
 state.doc.descendants((n,pos)=>{if(n.isText&&n.text==='P')position=pos})
 const selected=state.apply(state.tr.setSelection(TextSelection.create(state.doc,position)));let tr:Transaction|undefined
 expect(wrapInList(schema.nodes.ordered_list)(selected,t=>{tr=t})).toBe(true)
 const r=p.project(base,tr!);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(r.transaction.steps[0]).toBeInstanceOf(ReplaceAroundStep)
 const boundary=prepareSourceListBoundarySteps(base.session,r.transaction);expect(boundary.ok).toBe(true);if(!boundary.ok)throw Error(boundary.reason)
 for(const step of boundary.steps){tr!.step(step);r.transaction.step(step)}
 const source=applySourceBlockTransaction(base.session,r.transaction);expect(source.ok).toBe(true);if(!source.ok||!source.file)throw Error('missing file result')
 let id=0;const bindings=nextBindings(base,source.session,source.file.correspondence,()=> 'fresh'+id++);if(!bindings.ok)throw Error(bindings.reason)
 expect(p.appendBindings(tr!,source.session,bindings.bindings)).toEqual({ok:true})
 expect(p.project(base,tr!).ok).toBe(true)
 expect(neutralize(tr!.doc).eq(source.session.doc)).toBe(true)
 tr!.doc.descendants((node,pos)=>{if(tr!.doc.resolve(pos).depth>0&&Object.hasOwn(node.attrs,'cdrBlockId'))expect(node.attrs.cdrBlockId).toBe(null)})
})
it('private AttrStep grants are bound to instance, transaction, step and before/after',()=>{
 const {base,state}=setup('A'),p=createFileProjection(),tr=state.tr.insertText('B',2),first=p.project(base,tr)
 if(!first.ok)throw Error(first.reason)
 const source=applySourceBlockTransaction(base.session,first.transaction);if(!source.ok)throw Error(source.reason)
 expect(p.appendBindings(tr,source.session,[{rootOrdinal:0,id:'new'}])).toEqual({ok:true})
 expect(p.project(base,tr).ok).toBe(true);expect(createFileProjection().project(base,tr).ok).toBe(false)
 const copied=state.tr;for(const step of tr.steps)copied.step(step)
 expect(p.project(base,copied).ok).toBe(false)
 const json=state.tr;for(const step of tr.steps)json.step(Step.fromJSON(schema,step.toJSON()))
 expect(p.project(base,json).ok).toBe(false)
 const bad=state.tr.insertText('B',2),before=bad.doc
 expect(p.appendBindings(bad,source.session,[]).ok).toBe(false);expect(bad.doc).toBe(before);expect(bad.steps).toHaveLength(1)
})
it('foreign IDs in slices fail while existing or null IDs are neutralized without losing slice shape',()=>{
 const {base,state}=setup('A'),p=createFileProjection()
 for(const id of [null,'b0','stranger']){
  const node=schema.nodes.paragraph.create({cdrBlockId:id},schema.text('B')),tr=state.tr.insert(state.doc.content.size,node),r=p.project(base,tr)
  expect(r.ok).toBe(id!=='stranger')
  if(r.ok){const actual=tr.steps[0] as ReplaceStep,canonical=r.transaction.steps[0] as ReplaceStep
   expect([canonical.from,canonical.to,canonical.slice.openStart,canonical.slice.openEnd]).toEqual([actual.from,actual.to,actual.slice.openStart,actual.slice.openEnd])
   expect(canonical.slice.content.firstChild!.attrs.cdrBlockId).toBe(null)
  }
 }
 const identityOnly=state.tr.replaceWith(0,state.doc.content.size,state.doc.firstChild!.type.create({cdrBlockId:null},state.doc.firstChild!.content))
 expect(p.project(base,identityOnly).ok).toBe(false)
})
it('replays actual RemoveMark and node marks and rejects corrupted intermediate docs',()=>{
 const {base,state}=setup('**A**'),p=createFileProjection()
 for(const step of [new RemoveMarkStep(1,2,schema.marks.strong.create()),new AddNodeMarkStep(1,schema.marks.em.create()),new RemoveNodeMarkStep(1,schema.marks.strong.create())]){
  const current=step instanceof RemoveMarkStep?{base,state}:setup('![A](x)'),tr=current.state.tr.step(step),r=p.project(current.base,tr);expect(r.ok).toBe(true);if(r.ok)expect(r.transaction.steps[0].toJSON()).toEqual(step.toJSON())
 }
 const bad=state.tr.insertText('B',2).insertText('C',3);bad.docs[1]=state.doc
 expect(p.project(base,bad).ok).toBe(false)
})
it('installed root and history subentry share the actual transform registry',()=>{
 const raw=new SourceHistoryStep([{beforeLineage:'a',afterLineage:'b',beforeHash:'a'.repeat(64),afterHash:'b'.repeat(64),edits:[{from:0,to:1,removed:'a',text:'b'}]}])
 expect(Object.getPrototypeOf(Step.fromJSON(schema,raw.toJSON()))).toBe(SourceHistoryStep.prototype)
 const table=new TableLayoutStep([{id:'t',before:null,after:{position:0,columns:1,widths:[50]}}])
 expect(Object.getPrototypeOf(Step.fromJSON(schema,table.toJSON()))).toBe(TableLayoutStep.prototype)
})
it('a semantic no-op chain stays a controller no-op rather than an identity error',()=>{
 const {base,state}=setup('A'),tr=state.tr.insertText('B',1,2).insertText('A',1,2),r=createFileProjection().project(base,tr)
 expect(r.ok).toBe(true);if(r.ok)expect(r.transaction.doc.eq(base.session.doc)).toBe(true)
})
it('all actual top children survive wide marks around synthetic blanks',()=>{
 const {base,state}=setup('A\n\n\nB'),tr=state.tr.step(new AddMarkStep(1,state.doc.content.size-1,schema.marks.em.create())),r=createFileProjection().project(base,tr)
 expect(r.ok).toBe(true);if(!r.ok)throw Error(r.reason)
 expect(r.transaction.doc.childCount).toBe(3);expect(r.transaction.doc.child(1).content.size).toBe(0)
 expect(applySourceBlockTransaction(base.session,r.transaction).ok).toBe(true)
})
it('an undeclared identity-named attribute remains an ordinary actual AttrStep',()=>{
 const {base,state}=setup('![A](x)'),tr=state.tr.step(new AttrStep(1,'cdrBlockId','ignored-by-schema')),r=createFileProjection().project(base,tr)
 expect(r.ok).toBe(true);if(r.ok)expect(r.transaction.steps[0].toJSON()).toEqual(tr.steps[0].toJSON())
})
